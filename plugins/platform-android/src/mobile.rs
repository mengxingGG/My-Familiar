use serde::de::DeserializeOwned;
use tauri::{
  plugin::{PluginApi, PluginHandle},
  AppHandle, Runtime,
};

use serde_json::Value;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_familiar_android);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
  _app: &AppHandle<R>,
  api: PluginApi<R, C>,
) -> crate::Result<FamiliarAndroid<R>> {
  #[cfg(target_os = "android")]
  let handle = api.register_android_plugin("app.familiar.platform", "FamiliarPlugin")?;
  #[cfg(target_os = "ios")]
  let handle = api.register_ios_plugin(init_plugin_familiar_android)?;
  Ok(FamiliarAndroid(handle))
}

/// Access to the familiar-android APIs.
pub struct FamiliarAndroid<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> FamiliarAndroid<R> {
  pub fn invoke(&self, payload: Value) -> crate::Result<Value> {
    self
      .0
      .run_mobile_plugin("invoke", serde_json::json!({ "request": payload }))
      .map_err(Into::into)
  }
}
