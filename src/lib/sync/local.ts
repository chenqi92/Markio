import { api } from "@/lib/api";
import type { LocalFs } from "./engine";
import type { FileEntry } from "./types";
import type { ManifestIO } from "./manifest";

export function createLocalFs(): LocalFs {
  return {
    async scan(workspacePath) {
      const files = await api.syncScan(workspacePath);
      return files.map<FileEntry>((file) => ({
        relPath: file.relPath,
        mtime: file.mtime,
        hash: file.hash,
        size: file.size,
      }));
    },
    read(workspacePath, relPath) {
      return api.syncReadFileBase64(workspacePath, relPath);
    },
    async write(workspacePath, relPath, content) {
      const sig = await api.syncWriteFileBase64(workspacePath, relPath, content);
      return { hash: sig.hash, mtime: sig.mtime };
    },
    async softDelete(workspacePath, relPath) {
      const sig = await api.syncSoftDelete(workspacePath, relPath);
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

