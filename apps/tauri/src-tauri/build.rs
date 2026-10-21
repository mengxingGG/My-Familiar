fn main() {
  // ARM64 发布构件同时满足新设备的 16 KB 页对齐要求。
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
    println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
  }
  tauri_build::build()
}
