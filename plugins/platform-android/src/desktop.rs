use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use serde_json::Value;

pub fn init<R: Runtime, C: DeserializeOwned>(
  app: &AppHandle<R>,
  _api: PluginApi<R, C>,
) -> crate::Result<FamiliarAndroid<R>> {
  Ok(FamiliarAndroid(app.clone()))
}

/// Access to the familiar-android APIs.
pub struct FamiliarAndroid<R: Runtime>(AppHandle<R>);

impl<R: Runtime> FamiliarAndroid<R> {
  pub fn invoke(&self, payload: Value) -> crate::Result<Value> {
    Ok(serde_json::json!({"protocolVersion":1,"id":payload["id"],"ok":false,"error":{"code":"UNAVAILABLE"}}))
  }
}
