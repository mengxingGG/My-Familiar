use tauri::{AppHandle, command, Runtime};

use serde_json::Value;
use crate::Result;
use crate::FamiliarAndroidExt;

#[command]
pub(crate) async fn invoke<R: Runtime>(
    app: AppHandle<R>,
    payload: Value,
) -> Result<Value> {
    app.familiar_android().invoke(payload)
}
