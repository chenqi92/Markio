fn main() {
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
