//! iCloud Drive 默认路径侦测：macOS / Windows 给出客户端默认镜像目录，
//! Linux 上没有 iCloud 客户端，返回空串。

#[tauri::command]
pub fn icloud_default_path() -> Result<String, String> {
    let p = detect_icloud_path();
    match p {
        Some(path) if path.exists() => Ok(path.to_string_lossy().to_string()),
        _ => Ok(String::new()),
    }
}

fn detect_icloud_path() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").ok()?;
        Some(
            std::path::PathBuf::from(home)
                .join("Library")
                .join("Mobile Documents")
                .join("com~apple~CloudDocs"),
        )
    }
    #[cfg(target_os = "windows")]
    {
        let user = std::env::var("USERPROFILE").ok()?;
        // iCloud for Windows 现代版本一般落在 %USERPROFILE%\iCloudDrive
        // 旧版可能是 %USERPROFILE%\iCloud Drive
        let candidates = [
            std::path::PathBuf::from(&user).join("iCloudDrive"),
            std::path::PathBuf::from(&user).join("iCloud Drive"),
        ];
        for c in candidates {
            if c.exists() {
                return Some(c);
            }
        }
        Some(std::path::PathBuf::from(&user).join("iCloudDrive"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
}
