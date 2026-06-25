use std::collections::HashMap;

fn main() {
    inject_builtin_credentials();

    if std::env::var("CARGO_CFG_TARGET_OS").ok().as_deref() == Some("macos") {
        println!("cargo:rerun-if-changed=native/storefront.m");
        cc::Build::new()
            .file("native/storefront.m")
            .flag("-fobjc-arc")
            .compile("markio_storefront");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=StoreKit");
    }

    tauri_build::build()
}

/// 把内置网盘 OAuth 凭据以 `cargo:rustc-env` 注入，供 builtin_credentials.rs 的
/// `option_env!` 读取。值来源：①本地 gitignore 的 `credentials.env`（KEY=VALUE）；
/// ②进程环境变量（CI secret）。文件优先。两者都没有就不注入，运行时回退到用户自填。
fn inject_builtin_credentials() {
    const KEYS: &[&str] = &[
        "MARKIO_GDRIVE_CLIENT_ID",
        "MARKIO_ONEDRIVE_CLIENT_ID",
        "MARKIO_DROPBOX_CLIENT_ID",
        "MARKIO_DROPBOX_SECRET",
        "MARKIO_BAIDU_CLIENT_ID",
        "MARKIO_BAIDU_SECRET",
        "MARKIO_ALIYUN_APP_ID",
        "MARKIO_ALIYUN_SECRET",
    ];

    println!("cargo:rerun-if-changed=credentials.env");
    let mut file_vals: HashMap<String, String> = HashMap::new();
    if let Ok(content) = std::fs::read_to_string("credentials.env") {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                file_vals.insert(k.trim().to_string(), v.trim().trim_matches('"').to_string());
            }
        }
    }

    for &key in KEYS {
        println!("cargo:rerun-if-env-changed={key}");
        let val = file_vals
            .get(key)
            .cloned()
            .or_else(|| std::env::var(key).ok());
        if let Some(v) = val {
            let v = v.replace(['\n', '\r'], "");
            if !v.trim().is_empty() {
                println!("cargo:rustc-env={key}={v}");
            }
        }
    }
}
