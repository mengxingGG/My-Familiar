use tauri::{
  plugin::{Builder, TauriPlugin},
  Manager, Runtime,
};


#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::FamiliarAndroid;
#[cfg(mobile)]
use mobile::FamiliarAndroid;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the familiar-android APIs.
pub trait FamiliarAndroidExt<R: Runtime> {
  fn familiar_android(&self) -> &FamiliarAndroid<R>;
}

impl<R: Runtime, T: Manager<R>> crate::FamiliarAndroidExt<R> for T {
  fn familiar_android(&self) -> &FamiliarAndroid<R> {
    self.state::<FamiliarAndroid<R>>().inner()
  }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("familiar-android")
    .invoke_handler(tauri::generate_handler![commands::invoke])
    .setup(|app, api| {
      #[cfg(mobile)]
      let familiar_android = mobile::init(app, api)?;
      #[cfg(desktop)]
      let familiar_android = desktop::init(app, api)?;
      app.manage(familiar_android);
      Ok(())
    })
    .build()
}
