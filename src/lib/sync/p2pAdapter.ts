// P2P 局域网同步：把对端 markio 的金库当成一个「云盘」，复用现成的 sync 引擎三方 diff。
//
// 传输是到对端 Rust WS server（p2p.rs 的 /sync）的 WebSocket：
//   - 首帧 { op:"auth", token }
//   - 之后每个 RPC 一来一回（list/get/put/delete/mkdir），串行化（引擎本身顺序 await）
//
// content 全程 base64：与 localFs（Tauri 实现）一致，避免二进制资源损坏。

import { runSync } from "./engine";
import { createLocalFs, createManifestIO } from "./local";
import { TransportError } from "./transport";
import type { DriveAdapter } from "./transport";
import type { ConflictStrategy, FileEntry, SyncReport } from "./types";

export interface P2PPeer {
  peerId: string;
  name: string;
  host: string;
  port: number;
  token: string;
}

interface RpcResp {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** 一条到对端的 WS 连接，串行化 RPC（一来一回）。 */
function createConnection(peer: P2PPeer) {
  let socket: WebSocket | null = null;
  let opening: Promise<WebSocket> | null = null;
  // 串行链：保证同一连接上请求/响应不交错
  let tail: Promise<unknown> = Promise.resolve();

  const wsUrl = `ws://${peer.host}:${peer.port}/sync`;

  function open(): Promise<WebSocket> {
    if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
    if (opening) return opening;
    opening = new Promise<WebSocket>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (e) {
        opening = null;
        reject(new TransportError(`P2P 连接失败：${(e as Error).message}`, { transient: true }));
        return;
      }
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        opening = null;
        reject(new TransportError("P2P 连接超时", { transient: true }));
      }, 10_000);

      ws.onopen = () => {
        ws.send(JSON.stringify({ op: "auth", token: peer.token }));
      };
      ws.onmessage = (ev) => {
        // 第一帧是 auth 结果
        clearTimeout(timer);
        let r: RpcResp;
        try {
          r = JSON.parse(typeof ev.data === "string" ? ev.data : "") as RpcResp;
        } catch {
          opening = null;
          reject(new TransportError("P2P auth 响应无法解析", { transient: false }));
          return;
        }
        ws.onmessage = null;
        if (r.ok) {
          socket = ws;
          opening = null;
          resolve(ws);
        } else {
          opening = null;
          reject(new TransportError(`P2P auth 失败：${r.error ?? ""}`, { transient: false }));
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        opening = null;
        reject(new TransportError("P2P WebSocket 错误", { transient: true }));
      };
      ws.onclose = () => {
        if (socket === ws) socket = null;
      };
    });
    return opening;
  }

  function sendOne(req: unknown): Promise<unknown> {
    return open().then(
      (ws) =>
        new Promise<unknown>((resolve, reject) => {
          const onMsg = (ev: MessageEvent) => {
            ws.removeEventListener("message", onMsg);
            let r: RpcResp;
            try {
              r = JSON.parse(typeof ev.data === "string" ? ev.data : "") as RpcResp;
            } catch {
              reject(new TransportError("P2P 响应无法解析", { transient: false }));
              return;
            }
            if (r.ok) resolve(r.result);
            else reject(new TransportError(`P2P RPC 失败：${r.error ?? ""}`, { transient: false }));
          };
          ws.addEventListener("message", onMsg);
          try {
            ws.send(JSON.stringify(req));
          } catch (e) {
            ws.removeEventListener("message", onMsg);
            reject(new TransportError(`P2P 发送失败：${(e as Error).message}`, { transient: true }));
          }
        }),
    );
  }

  function rpc(req: unknown): Promise<unknown> {
    const result = tail.then(() => sendOne(req));
    // 保持链路推进，即便上一个失败
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function close() {
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
    socket = null;
  }

  return { rpc, close };
}

/** 用配对码连对端 /pair，换回对端的 device_id / 名称 / 金库 token。 */
export function pairWithPeer(
  host: string,
  port: number,
  code: string,
): Promise<{ peerId: string; name: string; token: string }> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://${host}:${port}/pair`);
    } catch (e) {
      reject(new Error(`配对连接失败：${(e as Error).message}`));
      return;
    }
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error("配对超时"));
    }, 10_000);
    ws.onopen = () => ws.send(JSON.stringify({ code }));
    ws.onmessage = (ev) => {
      clearTimeout(timer);
      let r: { ok: boolean; deviceId?: string; deviceName?: string; token?: string; error?: string };
      try {
        r = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error("配对响应无法解析"));
        return;
      }
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (r.ok && r.token && r.deviceId) {
        resolve({ peerId: r.deviceId, name: r.deviceName ?? r.deviceId, token: r.token });
      } else {
        reject(new Error(r.error ?? "配对失败"));
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("配对连接错误"));
    };
  });
}

/** 把对端金库包装成 DriveAdapter。remoteRoot 对 P2P 无意义（对端服务它自己的活跃仓库）。 */
export function createP2PAdapter(peer: P2PPeer): DriveAdapter & { close: () => void } {
  const conn = createConnection(peer);

  return {
    id: "p2p",
    close: conn.close,
    async list() {
      const raw = (await conn.rpc({ op: "list" })) as Array<{
        relPath: string;
        mtime: number;
        hash: string;
        size: number;
      }>;
      return raw.map(
        (e): FileEntry => ({
          relPath: e.relPath,
          mtime: e.mtime,
          hash: e.hash,
          size: e.size,
        }),
      );
    },
    async get(_remoteRoot, relPath) {
      const r = (await conn.rpc({ op: "get", rel_path: relPath })) as {
        contentBase64: string;
        etag: string;
        mtime: number;
      };
      return { content: r.contentBase64, etag: r.etag, mtime: r.mtime };
    },
    async put(_remoteRoot, relPath, content) {
      const r = (await conn.rpc({ op: "put", rel_path: relPath, content_base64: content })) as {
        etag: string;
        mtime: number;
      };
      return { etag: r.etag, mtime: r.mtime };
    },
    async delete(_remoteRoot, relPath) {
      await conn.rpc({ op: "delete", rel_path: relPath });
    },
    async ensureParentDir(_remoteRoot, relPath) {
      const dir = relPath.split("/").slice(0, -1).join("/");
      if (!dir) return;
      await conn.rpc({ op: "mkdir", rel_path: dir });
    },
  };
}

/** 跑一次与某个已配对对端的局域网同步。 */
export async function runP2PSync(
  peer: P2PPeer,
  workspacePath: string,
  conflictStrategy: ConflictStrategy,
  callbacks?: {
    onStage?: (stage: string, detail?: string) => void;
    onProgress?: (done: number, total: number, current?: string) => void;
  },
): Promise<SyncReport> {
  const adapter = createP2PAdapter(peer);
  try {
    return await runSync(
      workspacePath,
      "", // remoteRoot 对 P2P 无意义
      { conflictStrategy, now: Date.now },
      {
        adapter,
        manifestIo: createManifestIO(`p2p-${peer.peerId}`),
        localFs: createLocalFs(),
        onStage: callbacks?.onStage,
        onProgress: callbacks?.onProgress,
      },
    );
  } finally {
    adapter.close();
  }
}
