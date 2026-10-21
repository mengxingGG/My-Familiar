const COMMANDS: &[&str] = &["invoke"];

fn main() {
  tauri_plugin::Builder::new(COMMANDS)
    .android_path("android")
    .build();
}
