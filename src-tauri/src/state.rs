use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 文件指纹：mtime + 哈希。用来侦测保存时被外部改动覆盖。
#[derive(Clone, Copy, Debug)]
pub struct FileSig {
    pub mtime_ms: i64,
    pub hash: u64,
}

#[derive(Default)]
pub struct Inner {
    /// 前端注册过的 workspace 根目录（已 canonicalize）。所有 fs 命令必须落在其中。
    pub workspaces: HashSet<PathBuf>,
    /// 已打开文件的最新指纹。保存时校验。
    pub opened: HashMap<PathBuf, FileSig>,
}

#[derive(Default)]
pub struct AppState {
    pub inner: Mutex<Inner>,
}

impl AppState {
    pub fn register_workspace(&self, path: &Path) -> Result<PathBuf, String> {
        let canon = path
            .canonicalize()
            .map_err(|e| format!("无法注册仓库：{e}"))?;
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.workspaces.insert(canon.clone());
        Ok(canon)
    }

    /// 注销仓库。注销时仓库目录可能已被用户删除，因此 canonicalize 失败时
    /// 退而求其次按原路径匹配（前端通常会传上次 register 返回的 canon path）。
    pub fn unregister_workspace(&self, path: &Path) -> Result<PathBuf, String> {
        let canon = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.workspaces.remove(&canon);
        Ok(canon)
    }

    /// 调用方需保证 `path` 已经过 `ensure_in_workspaces` 校验（即已 canon）。
    /// 内部不再二次 canonicalize，避免 race（刚校验完文件被外部移除）下 key 退化。
    pub fn record_open(&self, path: &Path, sig: FileSig) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.opened.insert(path.to_path_buf(), sig);
        Ok(())
    }

    pub fn record_close(&self, path: &Path) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.opened.remove(path);
        Ok(())
    }

    pub fn last_sig(&self, path: &Path) -> Option<FileSig> {
        let inner = self.inner.lock().ok()?;
        inner.opened.get(path).copied()
    }
}

/// 校验 `target` 在已注册 workspace 内。文件未必已存在（保存场景），所以
/// 优先 canonicalize 自身，失败时退而 canonicalize 父目录再拼回去。
pub fn ensure_in_workspaces(
    workspaces: &HashSet<PathBuf>,
    target: &Path,
) -> Result<PathBuf, String> {
    let canon = if target.exists() {
        target
            .canonicalize()
            .map_err(|e| format!("路径无效：{e}"))?
    } else {
        let parent = target
            .parent()
            .ok_or_else(|| "路径没有父目录".to_string())?;
        let parent_canon = parent
            .canonicalize()
            .map_err(|e| format!("父目录无效：{e}"))?;
        let fname = target
            .file_name()
            .ok_or_else(|| "无法解析文件名".to_string())?;
        parent_canon.join(fname)
    };

    for ws in workspaces {
        if canon.starts_with(ws) {
            return Ok(canon);
        }
    }
    Err(format!(
        "拒绝访问：路径不在任何已注册仓库中（{}）",
        target.display()
    ))
}

/// 计算文件指纹（用 FxHash 风格的简单 64-bit hash 即可，足够侦测变更）
pub fn signature_for(path: &Path) -> std::io::Result<FileSig> {
    let meta = std::fs::metadata(path)?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let bytes = std::fs::read(path)?;
    let hash = hash64(&bytes);
    Ok(FileSig { mtime_ms, hash })
}

/// 同 signature_for，但用调用方已有的字节算哈希，省掉重新读盘。
/// 仅在「磁盘内容确定等于这些字节」时可用（如刚 atomic_write 写完）。
pub fn signature_for_bytes(path: &Path, bytes: &[u8]) -> std::io::Result<FileSig> {
    let meta = std::fs::metadata(path)?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Ok(FileSig {
        mtime_ms,
        hash: hash64(bytes),
    })
}

pub fn hash64(bytes: &[u8]) -> u64 {
    // FNV-1a 64-bit；足够检测意外改动
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}
