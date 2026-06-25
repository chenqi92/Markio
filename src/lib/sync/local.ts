import { api } from "@/lib/api";
import type { LocalFs } from "./engine";
import type { FileEntry } from "./types";
import type { ManifestIO } from "./manifest";

function normSubpath(localSubpath?: string): string {
  return (localSubpath ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .trim();
}

/**
 * 本地仓库文件访问。可选 localSubpath：只把仓库内某个子目录当作这次同步的“本地根”，
 * 实现「不同 provider 同步不同本地目录」的不相交挂载。relPath 对外是相对子目录的，
 * 内部访问 Rust fs_sync_* 时再拼回 `subpath/relPath`（这些命令的 relPath 始终相对仓库根）。
 * 不传 localSubpath 时行为与整仓同步完全一致。
 */
export function createLocalFs(localSubpath?: string): LocalFs {
  const sub = normSubpath(localSubpath);
  const prefix = sub ? `${sub}/` : "";
  const toRepo = (relPath: string) => `${prefix}${relPath}`;

  return {
    async scan(workspacePath) {
      const files = await api.syncScan(workspacePath);
      const out: FileEntry[] = [];
      for (const file of files) {
        let rel = file.relPath;
        if (sub) {
          // 只保留子目录下的文件，并把路径改写成相对子目录
          if (!rel.startsWith(prefix)) continue;
          rel = rel.slice(prefix.length);
          if (!rel) continue;
        }
        out.push({ relPath: rel, mtime: file.mtime, hash: file.hash, size: file.size });
      }
      return out;
    },
    read(workspacePath, relPath) {
      return api.syncReadFileBase64(workspacePath, toRepo(relPath));
    },
    async write(workspacePath, relPath, content) {
      const sig = await api.syncWriteFileBase64(workspacePath, toRepo(relPath), content);
      return { hash: sig.hash, mtime: sig.mtime };
    },
    async softDelete(workspacePath, relPath) {
      const sig = await api.syncSoftDelete(workspacePath, toRepo(relPath));
      return { hash: sig.hash };
    },
  };
}

export function createManifestIO(manifestId: string): ManifestIO {
  return {
    read(workspacePath) {
      return api.syncManifestRead(workspacePath, manifestId);
    },
    write(workspacePath, content) {
      return api.syncManifestWrite(workspacePath, manifestId, content);
    },
  };
}
