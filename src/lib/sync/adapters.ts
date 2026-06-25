import { api } from "@/lib/api";
import type { DriveConfig, DriveId as SettingsDriveId } from "@/stores/settings";
import type { DriveAdapter } from "./transport";
import type { DriveId, FileEntry } from "./types";

type S3Config = Parameters<typeof api.s3PutObject>[0];

export interface CloudSyncSettings {
  syncConflictStrategy: "ask" | "newest" | "local" | "remote";
  driveConfigs?: Partial<Record<SettingsDriveId, DriveConfig>>;
  webdavBaseUrl?: string;
  webdavUsername?: string;
  webdavRemoteDir?: string;
  s3Endpoint?: string;
  s3Region?: string;
  s3Bucket?: string;
  s3AccessKeyId?: string;
  s3PublicBaseUrl?: string;
  s3PathStyle?: boolean;
  synologyBaseUrl?: string;
  synologyUsername?: string;
  synologyInsecureTls?: boolean;
}

export interface CloudSyncTarget {
  id: DriveId;
  settingsId: SettingsDriveId;
  label: string;
  remoteRoot: string;
  manifestId: string;
  /** 只同步仓库内这个子目录（不相交挂载）；空 = 整个仓库 */
  localSubpath?: string;
  adapter: DriveAdapter;
}

const GDRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

function trimSlashes(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function trimRightSlashes(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "");
}

function joinRel(...parts: string[]): string {
  return parts.map(trimSlashes).filter(Boolean).join("/");
}

function joinDropbox(...parts: string[]): string {
  const joined = joinRel(...parts);
  return joined ? `/${joined}` : "";
}

function parentDirs(relPath: string): string[] {
  const parts = trimSlashes(relPath).split("/").filter(Boolean);
  parts.pop();
  const dirs: string[] = [];
  for (let i = 1; i <= parts.length; i += 1) {
    dirs.push(parts.slice(0, i).join("/"));
  }
  return dirs;
}

function stripRoot(fullPath: string, root: string): string | null {
  const full = trimSlashes(fullPath);
  const cleanRoot = trimSlashes(root);
  if (!cleanRoot) return full || null;
  if (full === cleanRoot) return null;
  if (!full.startsWith(`${cleanRoot}/`)) return null;
  return full.slice(cleanRoot.length + 1);
}

function stripRootCaseInsensitive(fullPath: string, root: string): string | null {
  const full = trimSlashes(fullPath);
  const cleanRoot = trimSlashes(root);
  if (!cleanRoot) return full || null;
  if (full.toLowerCase() === cleanRoot.toLowerCase()) return null;
  const prefix = `${cleanRoot}/`.toLowerCase();
  if (!full.toLowerCase().startsWith(prefix)) return null;
  return full.slice(cleanRoot.length + 1);
}

function parseTime(value: string | undefined, fallback = 0): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * put 之后立刻 stat 确认会撞上 S3/Dropbox/GDrive 列表的最终一致性窗口（刚写入的对象
 * 短时间内列不出来）。这里做有限退避重试，避免单次 stat miss 直接让整轮 upload 失败。
 */
async function statWithRetry(
  fn: () => Promise<FileEntry>,
  attempts = 4,
  baseDelayMs = 300,
): Promise<FileEntry> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (i + 1)));
      }
    }
  }
  throw lastErr;
}

function remoteHash(kind: string, ...parts: Array<string | number | undefined>): string {
  return `${kind}:${parts.map((p) => String(p ?? "")).join(":")}`;
}

function contentTypeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    md: "text/markdown",
    markdown: "text/markdown",
    txt: "text/plain",
    json: "application/json",
    csv: "text/csv",
    html: "text/html",
    css: "text/css",
    js: "text/javascript",
    ts: "text/typescript",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    zip: "application/zip",
  };
  return ext ? map[ext] ?? "application/octet-stream" : "application/octet-stream";
}

function isEnabled(cfg: DriveConfig | undefined): boolean {
  return !!cfg?.enabled;
}

function rootFromConfig(cfg: DriveConfig | undefined, fallback: string): string {
  return cfg?.folder?.trim() || fallback;
}

function localSubOf(cfg: DriveConfig | undefined): string {
  return (cfg?.localSubpath ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim();
}

/**
 * 把 localSubpath 折进 manifestId：换了子目录就用一份新 manifest（冷启动重新 diff），
 * 否则旧基线里相对老子目录的路径会被当成「本地已删」从而误删远端。
 */
function manifestIdWithSub(base: string, sub: string): string {
  if (!sub) return base;
  let h = 0;
  for (let i = 0; i < sub.length; i += 1) {
    h = (h * 31 + sub.charCodeAt(i)) >>> 0;
  }
  return `${base}-${h.toString(16)}`;
}

export function createCloudSyncTargets(settings: CloudSyncSettings): CloudSyncTarget[] {
  const configs = settings.driveConfigs ?? {};
  const targets: CloudSyncTarget[] = [];

  if (isEnabled(configs.webdav) && settings.webdavBaseUrl?.trim()) {
    const remoteRoot = trimSlashes(rootFromConfig(configs.webdav, settings.webdavRemoteDir || "markio"));
    const sub = localSubOf(configs.webdav);
    targets.push({
      id: "webdav",
      settingsId: "webdav",
      label: "WebDAV",
      remoteRoot,
      manifestId: manifestIdWithSub("cloud-webdav", sub),
      localSubpath: sub,
      adapter: createWebDavAdapter({
        baseUrl: settings.webdavBaseUrl.trim(),
        username: settings.webdavUsername ?? "",
      }),
    });
  }

  if (
    isEnabled(configs.s3) &&
    settings.s3Endpoint?.trim() &&
    settings.s3Bucket?.trim() &&
    settings.s3AccessKeyId?.trim()
  ) {
    const remoteRoot = trimSlashes(rootFromConfig(configs.s3, "markio"));
    const sub = localSubOf(configs.s3);
    targets.push({
      id: "s3",
      settingsId: "s3",
      label: "S3",
      remoteRoot,
      manifestId: manifestIdWithSub("cloud-s3", sub),
      localSubpath: sub,
      adapter: createS3Adapter({
        endpoint: settings.s3Endpoint.trim(),
        region: settings.s3Region || "us-east-1",
        bucket: settings.s3Bucket.trim(),
        accessKeyId: settings.s3AccessKeyId.trim(),
        secretAccessKey: "",
        publicBaseUrl: settings.s3PublicBaseUrl?.trim() || undefined,
        pathStyle: !!settings.s3PathStyle,
      }),
    });
  }

  if (isEnabled(configs.drop)) {
    const remoteRoot = joinDropbox(rootFromConfig(configs.drop, "/markio"));
    const sub = localSubOf(configs.drop);
    targets.push({
      id: "dropbox",
      settingsId: "drop",
      label: "Dropbox",
      remoteRoot,
      manifestId: manifestIdWithSub("cloud-dropbox", sub),
      localSubpath: sub,
      adapter: createDropboxAdapter(),
    });
  }

  if (isEnabled(configs.drive)) {
    const remoteRoot = rootFromConfig(configs.drive, "root").trim() || "root";
    const sub = localSubOf(configs.drive);
    targets.push({
      id: "gdrive",
      settingsId: "drive",
      label: "Google Drive",
      remoteRoot,
      manifestId: manifestIdWithSub("cloud-gdrive", sub),
      localSubpath: sub,
      adapter: createGDriveAdapter(),
    });
  }

  if (isEnabled(configs.onedrive)) {
    const remoteRoot = trimSlashes(rootFromConfig(configs.onedrive, "markio"));
    const sub = localSubOf(configs.onedrive);
    targets.push({
      id: "onedrive",
      settingsId: "onedrive",
      label: "OneDrive",
      remoteRoot,
      manifestId: manifestIdWithSub("cloud-onedrive", sub),
      localSubpath: sub,
      adapter: createOneDriveAdapter(),
    });
  }

  if (isEnabled(configs.synology) && settings.synologyBaseUrl?.trim() && settings.synologyUsername?.trim()) {
    const remoteRoot = trimRightSlashes(rootFromConfig(configs.synology, "/markio")) || "/markio";
    const sub = localSubOf(configs.synology);
    targets.push({
      id: "synology",
      settingsId: "synology",
      label: "Synology",
      remoteRoot: remoteRoot.startsWith("/") ? remoteRoot : `/${remoteRoot}`,
      manifestId: manifestIdWithSub("cloud-synology", sub),
      localSubpath: sub,
      adapter: createSynologyAdapter({
        baseUrl: settings.synologyBaseUrl.trim(),
        insecureTls: !!settings.synologyInsecureTls,
        username: settings.synologyUsername.trim(),
      }),
    });
  }

  if (isEnabled(configs.baidu)) {
    const root = trimRightSlashes(rootFromConfig(configs.baidu, "/apps/markio")) || "/apps/markio";
    const remoteRoot = root.startsWith("/") ? root : `/${root}`;
    const sub = localSubOf(configs.baidu);
    targets.push({
      id: "baidu",
      settingsId: "baidu",
      label: "百度网盘",
      remoteRoot,
      manifestId: manifestIdWithSub("cloud-baidu", sub),
      localSubpath: sub,
      adapter: createBaiduAdapter(),
    });
  }

  if (isEnabled(configs.aliyun)) {
    const remoteRoot = trimSlashes(rootFromConfig(configs.aliyun, "markio"));
    const sub = localSubOf(configs.aliyun);
    targets.push({
      id: "aliyun",
      settingsId: "aliyun",
      label: "阿里云盘",
      remoteRoot,
      manifestId: manifestIdWithSub("cloud-aliyun", sub),
      localSubpath: sub,
      adapter: createAliyunAdapter(),
    });
  }

  return targets;
}

export function createWebDavAdapter(config: {
  baseUrl: string;
  username: string;
}): DriveAdapter {
  const auth = () => ({ username: config.username, password: "" });

  const stat = async (remoteRoot: string, relPath: string): Promise<FileEntry> => {
    const full = joinRel(remoteRoot, relPath);
    const parent = full.split("/").slice(0, -1).join("/");
    const fileName = full.split("/").pop();
    const entries = await api.webdavList(config.baseUrl, auth(), parent);
    const found = entries.find((entry) => !entry.isDir && trimSlashes(entry.relPath) === full);
    if (!found) {
      throw new Error(`WebDAV 未找到刚写入的文件：${relPath || fileName || full}`);
    }
    const mtime = parseTime(found.lastModified);
    return {
      relPath,
      mtime,
      hash: remoteHash("webdav", found.size, found.lastModified),
      size: found.size,
    };
  };

  return {
    id: "webdav",
    async list(remoteRoot) {
      const out: FileEntry[] = [];
      const cleanRoot = trimSlashes(remoteRoot);
      const walk = async (dir: string) => {
        const dirNorm = trimRightSlashes(dir);
        const entries = await api.webdavList(config.baseUrl, auth(), dir);
        for (const entry of entries) {
          const full = trimRightSlashes(entry.relPath);
          // PROPFIND Depth:1 会把被请求的集合自身也返回（RFC 4918）。不跳过的话，
          // 每个子目录的自我条目都会触发 walk(自己) 形成无限递归，整个同步永不返回。
          if (entry.isDir && full === dirNorm) continue;
          const rel = stripRoot(full, cleanRoot);
          if (rel === null) continue;
          if (entry.isDir) {
            await walk(full);
            continue;
          }
          const mtime = parseTime(entry.lastModified);
          out.push({
            relPath: rel,
            mtime,
            hash: remoteHash("webdav", entry.size, entry.lastModified),
            size: entry.size,
          });
        }
      };
      await walk(cleanRoot);
      out.sort((a, b) => a.relPath.localeCompare(b.relPath));
      return out;
    },
    async get(remoteRoot, relPath) {
      const full = joinRel(remoteRoot, relPath);
      const [content, meta] = await Promise.all([
        api.webdavGet(config.baseUrl, auth(), full),
        stat(remoteRoot, relPath),
      ]);
      return { content, etag: meta.hash, mtime: meta.mtime };
    },
    async put(remoteRoot, relPath, content) {
      const full = joinRel(remoteRoot, relPath);
      await api.webdavPut(config.baseUrl, auth(), full, content);
      const meta = await statWithRetry(() => stat(remoteRoot, relPath));
      return { etag: meta.hash, mtime: meta.mtime };
    },
    delete(remoteRoot, relPath) {
      return api.webdavDelete(config.baseUrl, auth(), joinRel(remoteRoot, relPath));
    },
    async ensureParentDir(remoteRoot, relPath) {
      const dirs = [trimSlashes(remoteRoot), ...parentDirs(relPath).map((dir) => joinRel(remoteRoot, dir))]
        .filter(Boolean);
      for (const dir of dirs) {
        await api.webdavMkcol(config.baseUrl, auth(), dir);
      }
    },
  };
}

export function createS3Adapter(config: S3Config): DriveAdapter {
  const keyFor = (remoteRoot: string, relPath: string) => joinRel(remoteRoot, relPath);
  const stat = async (remoteRoot: string, relPath: string): Promise<FileEntry> => {
    const key = keyFor(remoteRoot, relPath);
    const res = await api.s3ListObjects(config, key, undefined, 1);
    const found = res.objects.find((obj) => obj.key === key);
    if (!found) throw new Error(`S3 未找到刚写入的对象：${key}`);
    const mtime = parseTime(found.lastModified);
    return {
      relPath,
      mtime,
      hash: remoteHash("s3", found.etag, found.size, found.lastModified),
      size: found.size,
    };
  };

  return {
    id: "s3",
    async list(remoteRoot) {
      const prefix = trimSlashes(remoteRoot);
      const listPrefix = prefix ? `${prefix}/` : "";
      const out: FileEntry[] = [];
      let token: string | undefined;
      do {
        const res = await api.s3ListObjects(config, listPrefix, token, 1000);
        for (const obj of res.objects) {
          const rel = stripRoot(obj.key, prefix);
          if (!rel) continue;
          const mtime = parseTime(obj.lastModified);
          out.push({
            relPath: rel,
            mtime,
            hash: remoteHash("s3", obj.etag, obj.size, obj.lastModified),
            size: obj.size,
          });
        }
        token = res.nextContinuationToken ?? undefined;
        if (!res.isTruncated) token = undefined;
      } while (token);
      out.sort((a, b) => a.relPath.localeCompare(b.relPath));
      return out;
    },
    async get(remoteRoot, relPath) {
      const key = keyFor(remoteRoot, relPath);
      const [content, meta] = await Promise.all([
        api.s3GetObject(config, key),
        stat(remoteRoot, relPath),
      ]);
      return { content, etag: meta.hash, mtime: meta.mtime };
    },
    async put(remoteRoot, relPath, content) {
      await api.s3PutObject(config, keyFor(remoteRoot, relPath), content, contentTypeFromPath(relPath));
      const meta = await statWithRetry(() => stat(remoteRoot, relPath));
      return { etag: meta.hash, mtime: meta.mtime };
    },
    delete(remoteRoot, relPath) {
      return api.s3DeleteObject(config, keyFor(remoteRoot, relPath));
    },
    async ensureParentDir() {
      // S3 key 前缀不需要显式建目录。
    },
  };
}

export function createDropboxAdapter(): DriveAdapter {
  const fullPath = (remoteRoot: string, relPath: string) => joinDropbox(remoteRoot, relPath);

  const listAll = async (path: string) => {
    const entries: Awaited<ReturnType<typeof api.dropboxList>>["entries"] = [];
    let page = await api.dropboxList(path);
    entries.push(...page.entries);
    while (page.hasMore && page.cursor) {
      page = await api.dropboxListContinue(page.cursor);
      entries.push(...page.entries);
    }
    return entries;
  };

  const stat = async (remoteRoot: string, relPath: string): Promise<FileEntry> => {
    const target = fullPath(remoteRoot, relPath).toLowerCase();
    const parent = target.split("/").slice(0, -1).join("/");
    const entries = await listAll(parent);
    const found = entries.find(
      (entry) => entry.tag === "file" && (entry.pathLower || "").toLowerCase() === target,
    );
    if (!found) throw new Error(`Dropbox 未找到刚写入的文件：${relPath}`);
    const mtime = parseTime(found.serverModified);
    return {
      relPath,
      mtime,
      hash: remoteHash("dropbox", found.size, found.serverModified),
      size: found.size,
    };
  };

  return {
    id: "dropbox",
    async list(remoteRoot) {
      const cleanRoot = joinDropbox(remoteRoot);
      const out: FileEntry[] = [];
      const walk = async (dir: string) => {
        for (const entry of await listAll(dir)) {
          const displayPath = entry.pathDisplay || entry.pathLower;
          const rel = stripRootCaseInsensitive(displayPath, cleanRoot);
          if (rel === null) continue;
          if (entry.tag === "folder") {
            await walk(displayPath || entry.pathLower);
            continue;
          }
          if (entry.tag !== "file") continue;
          const mtime = parseTime(entry.serverModified);
          out.push({
            relPath: rel,
            mtime,
            hash: remoteHash("dropbox", entry.size, entry.serverModified),
            size: entry.size,
          });
        }
      };
      await walk(cleanRoot);
      out.sort((a, b) => a.relPath.localeCompare(b.relPath));
      return out;
    },
    async get(remoteRoot, relPath) {
      const path = fullPath(remoteRoot, relPath);
      const [content, meta] = await Promise.all([
        api.dropboxDownload(path),
        stat(remoteRoot, relPath),
      ]);
      return { content, etag: meta.hash, mtime: meta.mtime };
    },
    async put(remoteRoot, relPath, content) {
      await api.dropboxUpload(fullPath(remoteRoot, relPath), content);
      const meta = await statWithRetry(() => stat(remoteRoot, relPath));
      return { etag: meta.hash, mtime: meta.mtime };
    },
    delete(remoteRoot, relPath) {
      return api.dropboxDelete(fullPath(remoteRoot, relPath));
    },
    async ensureParentDir(remoteRoot, relPath) {
      const dirs = [joinDropbox(remoteRoot), ...parentDirs(relPath).map((dir) => fullPath(remoteRoot, dir))]
        .filter(Boolean);
      for (const dir of dirs) {
        await api.dropboxCreateFolder(dir);
      }
    },
  };
}

export interface SynologyAdapterConfig {
  baseUrl: string;
  insecureTls: boolean;
  username: string;
}

export function createSynologyAdapter(cfg: SynologyAdapterConfig): DriveAdapter {
  let sid: string | null = null;
  const login = async (): Promise<string> => {
    const r = await api.synologyLogin(cfg.baseUrl, cfg.insecureTls, cfg.username);
    sid = r.sid;
    return sid;
  };
  // sid 失效（错误码 119）时重登一次再重试
  const withSid = async <T>(fn: (sid: string) => Promise<T>): Promise<T> => {
    const s = sid ?? (await login());
    try {
      return await fn(s);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("119") || msg.includes("sid")) {
        return await fn(await login());
      }
      throw e;
    }
  };

  // Synology 用 NAS 绝对路径；remoteRoot 形如 /markio
  const absJoin = (remoteRoot: string, relPath: string): string => {
    const root = trimRightSlashes(remoteRoot) || "";
    const base = root.startsWith("/") ? root : `/${trimSlashes(root)}`;
    const tail = trimSlashes(relPath);
    return tail ? `${base}/${tail}` : base;
  };

  const stat = async (remoteRoot: string, relPath: string): Promise<FileEntry> => {
    const full = absJoin(remoteRoot, relPath);
    const parent = full.slice(0, full.lastIndexOf("/")) || "/";
    const { entries } = await withSid((s) =>
      api.synologyList(cfg.baseUrl, cfg.insecureTls, s, parent),
    );
    const found = entries.find((e) => !e.isDir && e.path === full);
    if (!found) throw new Error(`Synology 未找到刚写入的文件：${relPath}`);
    return {
      relPath,
      mtime: found.mtime * 1000,
      hash: remoteHash("synology", found.size, found.mtime),
      size: found.size,
    };
  };

  return {
    id: "synology",
    async list(remoteRoot) {
      const out: FileEntry[] = [];
      const root = absJoin(remoteRoot, "");
      const walk = async (dir: string) => {
        const { entries } = await withSid((s) =>
          api.synologyList(cfg.baseUrl, cfg.insecureTls, s, dir),
        );
        for (const e of entries) {
          if (e.isDir) {
            await walk(e.path);
            continue;
          }
          const rel = stripRoot(e.path, root);
          if (rel === null) continue;
          out.push({
            relPath: rel,
            mtime: e.mtime * 1000,
            hash: remoteHash("synology", e.size, e.mtime),
            size: e.size,
          });
        }
      };
      await walk(root);
      out.sort((a, b) => a.relPath.localeCompare(b.relPath));
      return out;
    },
    async get(remoteRoot, relPath) {
      const full = absJoin(remoteRoot, relPath);
      const [content, meta] = await Promise.all([
        withSid((s) => api.synologyDownload(cfg.baseUrl, cfg.insecureTls, s, full)),
        stat(remoteRoot, relPath),
      ]);
      return { content, etag: meta.hash, mtime: meta.mtime };
    },
    async put(remoteRoot, relPath, content) {
      const full = absJoin(remoteRoot, relPath);
      const idx = full.lastIndexOf("/");
      const destFolder = full.slice(0, idx) || "/";
      const name = full.slice(idx + 1);
      await withSid((s) =>
        api.synologyUpload(cfg.baseUrl, cfg.insecureTls, s, destFolder, name, content),
      );
      const meta = await statWithRetry(() => stat(remoteRoot, relPath));
      return { etag: meta.hash, mtime: meta.mtime };
    },
    delete(remoteRoot, relPath) {
      return withSid((s) =>
        api.synologyDelete(cfg.baseUrl, cfg.insecureTls, s, absJoin(remoteRoot, relPath)),
      );
    },
    async ensureParentDir() {
      // Synology Upload create_parents=true 已自动建父目录
    },
  };
}

export function createBaiduAdapter(): DriveAdapter {
  const fsIds = new Map<string, string>();
  const absJoin = (remoteRoot: string, relPath: string): string => {
    const base = `/${trimSlashes(remoteRoot)}`;
    const tail = trimSlashes(relPath);
    return tail ? `${base}/${tail}` : base;
  };
  const entryHash = (md5: string, size: number, mtime: number) =>
    remoteHash("baidu", md5 || String(size), size, mtime);

  const findFsId = async (remoteRoot: string, relPath: string): Promise<string | null> => {
    const cached = fsIds.get(relPath);
    if (cached) return cached;
    const full = absJoin(remoteRoot, relPath);
    const parent = full.slice(0, full.lastIndexOf("/")) || "/";
    const { entries } = await api.baiduList(parent);
    const found = entries.find((e) => !e.isDir && e.path === full);
    if (!found) return null;
    fsIds.set(relPath, found.fsId);
    return found.fsId;
  };

  const stat = async (remoteRoot: string, relPath: string): Promise<FileEntry> => {
    const full = absJoin(remoteRoot, relPath);
    const parent = full.slice(0, full.lastIndexOf("/")) || "/";
    const { entries } = await api.baiduList(parent);
    const found = entries.find((e) => !e.isDir && e.path === full);
    if (!found) throw new Error(`百度网盘未找到刚写入的文件：${relPath}`);
    fsIds.set(relPath, found.fsId);
    return {
      relPath,
      mtime: found.mtime * 1000,
      hash: entryHash(found.md5, found.size, found.mtime),
      size: found.size,
    };
  };

  return {
    id: "baidu",
    async list(remoteRoot) {
      fsIds.clear();
      const out: FileEntry[] = [];
      const root = `/${trimSlashes(remoteRoot)}`;
      const walk = async (dir: string) => {
        const { entries } = await api.baiduList(dir);
        for (const e of entries) {
          if (e.isDir) {
            await walk(e.path);
            continue;
          }
          const rel = stripRoot(e.path, root);
          if (rel === null) continue;
          fsIds.set(rel, e.fsId);
          out.push({
            relPath: rel,
            mtime: e.mtime * 1000,
            hash: entryHash(e.md5, e.size, e.mtime),
            size: e.size,
          });
        }
      };
      await walk(root);
      out.sort((a, b) => a.relPath.localeCompare(b.relPath));
      return out;
    },
    async get(remoteRoot, relPath) {
      const fsId = await findFsId(remoteRoot, relPath);
      if (!fsId) throw new Error(`百度网盘文件不存在：${relPath}`);
      const [content, meta] = await Promise.all([
        api.baiduDownload(fsId),
        stat(remoteRoot, relPath),
      ]);
      return { content, etag: meta.hash, mtime: meta.mtime };
    },
    async put(remoteRoot, relPath, content) {
      await api.baiduUpload(absJoin(remoteRoot, relPath), content);
      fsIds.delete(relPath);
      const meta = await statWithRetry(() => stat(remoteRoot, relPath));
      return { etag: meta.hash, mtime: meta.mtime };
    },
    async delete(remoteRoot, relPath) {
      await api.baiduDelete(absJoin(remoteRoot, relPath));
      fsIds.delete(relPath);
    },
    async ensureParentDir() {
      // 百度 create/precreate 会自动建父目录
    },
  };
}

export function createAliyunAdapter(): DriveAdapter {
  const fileIds = new Map<string, string>();
  const folderIds = new Map<string, string>();

  const entryHash = (contentHash: string, size: number, mtime: string) =>
    remoteHash("aliyun", contentHash || String(size), size, mtime);

  const ensureFolder = async (remoteRoot: string, relDir: string): Promise<string> => {
    folderIds.set("", "root");
    let parentId = "root";
    let currentPath = "";
    const segments = trimSlashes(joinRel(remoteRoot, relDir)).split("/").filter(Boolean);
    for (const segment of segments) {
      currentPath = joinRel(currentPath, segment);
      const cached = folderIds.get(currentPath);
      if (cached) {
        parentId = cached;
        continue;
      }
      const { entries } = await api.aliyunList(parentId);
      const existing = entries.find((e) => e.isDir && e.name === segment);
      if (existing) {
        folderIds.set(currentPath, existing.fileId);
        parentId = existing.fileId;
        continue;
      }
      const created = await api.aliyunCreateFolder(parentId, segment);
      folderIds.set(currentPath, created);
      parentId = created;
    }
    return parentId;
  };

  const findFile = async (remoteRoot: string, relPath: string): Promise<string | null> => {
    const cached = fileIds.get(relPath);
    if (cached) return cached;
    const parentRel = trimSlashes(relPath).split("/").slice(0, -1).join("/");
    const name = trimSlashes(relPath).split("/").pop() || relPath;
    const parentId = await ensureFolder(remoteRoot, parentRel);
    const { entries } = await api.aliyunList(parentId);
    const existing = entries.find((e) => !e.isDir && e.name === name);
    if (!existing) return null;
    fileIds.set(relPath, existing.fileId);
    return existing.fileId;
  };

  const stat = async (remoteRoot: string, relPath: string): Promise<FileEntry> => {
    const parentRel = trimSlashes(relPath).split("/").slice(0, -1).join("/");
    const name = trimSlashes(relPath).split("/").pop() || relPath;
    const parentId = await ensureFolder(remoteRoot, parentRel);
    const { entries } = await api.aliyunList(parentId);
    const found = entries.find((e) => !e.isDir && e.name === name);
    if (!found) throw new Error(`阿里云盘未找到刚写入的文件：${relPath}`);
    fileIds.set(relPath, found.fileId);
    return {
      relPath,
      mtime: parseTime(found.mtime),
      hash: entryHash(found.contentHash, found.size, found.mtime),
      size: found.size,
    };
  };

  return {
    id: "aliyun",
    async list(remoteRoot) {
      fileIds.clear();
      folderIds.clear();
      const out: FileEntry[] = [];
      const rootId = await ensureFolder(remoteRoot, "");
      const walk = async (parentId: string, prefix: string) => {
        const { entries } = await api.aliyunList(parentId);
        for (const e of entries) {
          const rel = joinRel(prefix, e.name);
          if (e.isDir) {
            folderIds.set(joinRel(trimSlashes(remoteRoot), rel), e.fileId);
            await walk(e.fileId, rel);
            continue;
          }
          fileIds.set(rel, e.fileId);
          out.push({
            relPath: rel,
            mtime: parseTime(e.mtime),
            hash: entryHash(e.contentHash, e.size, e.mtime),
            size: e.size,
          });
        }
      };
      await walk(rootId, "");
      out.sort((a, b) => a.relPath.localeCompare(b.relPath));
      return out;
    },
    async get(remoteRoot, relPath) {
      const id = await findFile(remoteRoot, relPath);
      if (!id) throw new Error(`阿里云盘文件不存在：${relPath}`);
      const [content, meta] = await Promise.all([
        api.aliyunDownload(id),
        stat(remoteRoot, relPath),
      ]);
      return { content, etag: meta.hash, mtime: meta.mtime };
    },
    async put(remoteRoot, relPath, content) {
      const parentRel = trimSlashes(relPath).split("/").slice(0, -1).join("/");
      const name = trimSlashes(relPath).split("/").pop() || relPath;
      const parentId = await ensureFolder(remoteRoot, parentRel);
      const existingId = await findFile(remoteRoot, relPath);
      const id = await api.aliyunUpload(parentId, name, existingId, content);
      if (id) fileIds.set(relPath, id);
      const meta = await statWithRetry(() => stat(remoteRoot, relPath));
      return { etag: meta.hash, mtime: meta.mtime };
    },
    async delete(remoteRoot, relPath) {
      const id = await findFile(remoteRoot, relPath);
      if (id) {
        await api.aliyunDelete(id);
        fileIds.delete(relPath);
      }
    },
    async ensureParentDir(remoteRoot, relPath) {
      const parentRel = trimSlashes(relPath).split("/").slice(0, -1).join("/");
      await ensureFolder(remoteRoot, parentRel);
    },
  };
}

export function createOneDriveAdapter(): DriveAdapter {
  const stat = async (remoteRoot: string, relPath: string): Promise<FileEntry> => {
    const full = joinRel(remoteRoot, relPath);
    const parent = full.split("/").slice(0, -1).join("/");
    const { entries } = await api.onedriveList(parent);
    const found = entries.find(
      (e) => e.tag === "file" && trimSlashes(e.path) === trimSlashes(full),
    );
    if (!found) throw new Error(`OneDrive 未找到刚写入的文件：${relPath}`);
    return {
      relPath,
      mtime: parseTime(found.lastModified),
      hash: remoteHash("onedrive", found.etag, found.size, found.lastModified),
      size: found.size,
    };
  };

  return {
    id: "onedrive",
    async list(remoteRoot) {
      const out: FileEntry[] = [];
      const cleanRoot = trimSlashes(remoteRoot);
      const walk = async (dir: string) => {
        const { entries } = await api.onedriveList(dir);
        for (const e of entries) {
          if (e.tag === "folder") {
            await walk(trimSlashes(e.path));
            continue;
          }
          const rel = stripRoot(e.path, cleanRoot);
          if (rel === null) continue;
          out.push({
            relPath: rel,
            mtime: parseTime(e.lastModified),
            hash: remoteHash("onedrive", e.etag, e.size, e.lastModified),
            size: e.size,
          });
        }
      };
      await walk(cleanRoot);
      out.sort((a, b) => a.relPath.localeCompare(b.relPath));
      return out;
    },
    async get(remoteRoot, relPath) {
      const full = joinRel(remoteRoot, relPath);
      const [content, meta] = await Promise.all([
        api.onedriveDownload(full),
        stat(remoteRoot, relPath),
      ]);
      return { content, etag: meta.hash, mtime: meta.mtime };
    },
    async put(remoteRoot, relPath, content) {
      await api.onedriveUpload(joinRel(remoteRoot, relPath), content);
      const meta = await statWithRetry(() => stat(remoteRoot, relPath));
      return { etag: meta.hash, mtime: meta.mtime };
    },
    delete(remoteRoot, relPath) {
      return api.onedriveDelete(joinRel(remoteRoot, relPath));
    },
    async ensureParentDir(remoteRoot, relPath) {
      const dirs = [trimSlashes(remoteRoot), ...parentDirs(relPath).map((dir) => joinRel(remoteRoot, dir))]
        .filter(Boolean);
      for (const dir of dirs) {
        await api.onedriveCreateFolder(dir);
      }
    },
  };
}

export function createGDriveAdapter(): DriveAdapter {
  const fileIds = new Map<string, string>();
  const folderIds = new Map<string, string>();

  const queryChildren = async (parentId: string) => {
    const files: Awaited<ReturnType<typeof api.gdriveList>>["files"] = [];
    const q = `'${parentId.replace(/'/g, "\\'")}' in parents and trashed=false`;
    let pageToken: string | undefined;
    do {
      const page = await api.gdriveList(q, pageToken);
      files.push(...page.files);
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken);
    return files;
  };

  const fileEntry = (relPath: string, file: {
    size: number;
    modifiedTime: string;
  }): FileEntry => {
    const mtime = parseTime(file.modifiedTime);
    return {
      relPath,
      mtime,
      hash: remoteHash("gdrive", file.size, file.modifiedTime),
      size: file.size,
    };
  };

  const ensureFolder = async (remoteRoot: string, relDir: string): Promise<string> => {
    const root = remoteRoot || "root";
    folderIds.set("", root);
    let parentId = root;
    let currentPath = "";
    for (const segment of trimSlashes(relDir).split("/").filter(Boolean)) {
      currentPath = joinRel(currentPath, segment);
      const cached = folderIds.get(currentPath);
      if (cached) {
        parentId = cached;
        continue;
      }
      const existing = (await queryChildren(parentId)).find(
        (file) => file.mimeType === GDRIVE_FOLDER_MIME && file.name === segment,
      );
      if (existing) {
        folderIds.set(currentPath, existing.id);
        parentId = existing.id;
        continue;
      }
      const created = await api.gdriveCreateFolder(segment, parentId);
      folderIds.set(currentPath, created);
      parentId = created;
    }
    return parentId;
  };

  const findFile = async (remoteRoot: string, relPath: string) => {
    const cached = fileIds.get(relPath);
    if (cached) return cached;
    const parentPath = trimSlashes(relPath).split("/").slice(0, -1).join("/");
    const name = trimSlashes(relPath).split("/").pop() || relPath;
    const parentId = await ensureFolder(remoteRoot, parentPath);
    const existing = (await queryChildren(parentId)).find(
      (file) => file.mimeType !== GDRIVE_FOLDER_MIME && file.name === name,
    );
    if (!existing) return null;
    fileIds.set(relPath, existing.id);
    return existing.id;
  };

  const stat = async (remoteRoot: string, relPath: string): Promise<FileEntry> => {
    const parentPath = trimSlashes(relPath).split("/").slice(0, -1).join("/");
    const name = trimSlashes(relPath).split("/").pop() || relPath;
    const parentId = await ensureFolder(remoteRoot, parentPath);
    const found = (await queryChildren(parentId)).find(
      (file) => file.mimeType !== GDRIVE_FOLDER_MIME && file.name === name,
    );
    if (!found) throw new Error(`Google Drive 未找到刚写入的文件：${relPath}`);
    fileIds.set(relPath, found.id);
    return fileEntry(relPath, found);
  };

  return {
    id: "gdrive",
    async list(remoteRoot) {
      fileIds.clear();
      folderIds.clear();
      folderIds.set("", remoteRoot || "root");
      const out: FileEntry[] = [];
      const walk = async (folderId: string, prefix: string) => {
        for (const file of await queryChildren(folderId)) {
          const rel = joinRel(prefix, file.name);
          if (file.mimeType === GDRIVE_FOLDER_MIME) {
            folderIds.set(rel, file.id);
            await walk(file.id, rel);
            continue;
          }
          fileIds.set(rel, file.id);
          out.push(fileEntry(rel, file));
        }
      };
      await walk(remoteRoot || "root", "");
      out.sort((a, b) => a.relPath.localeCompare(b.relPath));
      return out;
    },
    async get(remoteRoot, relPath) {
      const id = await findFile(remoteRoot, relPath);
      if (!id) throw new Error(`Google Drive 文件不存在：${relPath}`);
      const [content, meta] = await Promise.all([
        api.gdriveDownload(id),
        stat(remoteRoot, relPath),
      ]);
      return { content, etag: meta.hash, mtime: meta.mtime };
    },
    async put(remoteRoot, relPath, content) {
      const parentPath = trimSlashes(relPath).split("/").slice(0, -1).join("/");
      const name = trimSlashes(relPath).split("/").pop() || relPath;
      const parentId = await ensureFolder(remoteRoot, parentPath);
      const existingId = await findFile(remoteRoot, relPath);
      const id = await api.gdriveUpload(
        name,
        parentId,
        existingId,
        content,
        contentTypeFromPath(relPath),
      );
      fileIds.set(relPath, id);
      const meta = await statWithRetry(() => stat(remoteRoot, relPath));
      return { etag: meta.hash, mtime: meta.mtime };
    },
    async delete(remoteRoot, relPath) {
      const id = await findFile(remoteRoot, relPath);
      if (id) {
        await api.gdriveDelete(id);
        fileIds.delete(relPath);
      }
    },
    async ensureParentDir(remoteRoot, relPath) {
      const parentPath = trimSlashes(relPath).split("/").slice(0, -1).join("/");
      await ensureFolder(remoteRoot, parentPath);
    },
  };
}
