// DriveAdapter —— 统一的远端 transport 接口。
// 每个云盘（webdav / s3 / dropbox / gdrive）实现这个接口，引擎本身不知道具体协议。

import type { FileEntry } from "./types";

/** transport 抛错时表明这一类，决定要不要重试 */
export class TransportError extends Error {
  readonly transient: boolean;
  readonly status?: number;

  constructor(message: string, opts: { transient: boolean; status?: number }) {
    super(message);
    this.name = "TransportError";
    this.transient = opts.transient;
    this.status = opts.status;
  }
}

export interface DriveAdapter {
  /** 列出 remoteRoot 下所有文件（递归），按 relPath 形式返回 */
  list(remoteRoot: string): Promise<FileEntry[]>;

  /** 读单个文件内容（utf-8 文本；二进制走 base64 由 adapter 内部决定） */
  get(remoteRoot: string, relPath: string): Promise<{
    content: string;
    etag: string;
    mtime: number;
  }>;

  /** 写单个文件；返回写完后的 etag + mtime 用于回写 manifest */
  put(
    remoteRoot: string,
    relPath: string,
    content: string,
  ): Promise<{ etag: string; mtime: number }>;

  /** 删除单个文件 */
  delete(remoteRoot: string, relPath: string): Promise<void>;

  /** 确保 relPath 的父目录存在；S3 / GDrive 通常 no-op，WebDAV 需要 mkcol */
  ensureParentDir(remoteRoot: string, relPath: string): Promise<void>;

  /** 名字，主要给日志 / 诊断用 */
  readonly id: string;
}
