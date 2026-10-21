param([switch]$Release, [switch]$Migration)
if ($Release -and $Migration) { throw 'Migration build uses the previous debug application identity, not the release identity.' }
if ($Migration) { $env:FAMILIAR_ANDROID_MIGRATION = '1' } else { Remove-Item Env:FAMILIAR_ANDROID_MIGRATION -ErrorAction SilentlyContinue }
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'android-env.ps1')
Set-Location (Split-Path -Parent $PSScriptRoot)
& node scripts/prepare-android-node.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& (Join-Path $PSScriptRoot 'build-android-feishu-wasm.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node scripts/build-mobile-ui.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node scripts/build-android-runtime.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
# 原生库变大后，增量 ZIP 可能留下旧库的未引用压缩段；只清理生成 APK，让打包器重建紧凑归档。
$relativeApk = if ($Release) { 'apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk' } else { 'apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk' }
$generatedApk = Join-Path (Split-Path -Parent $PSScriptRoot) $relativeApk
if (-not $relativeApk -or [IO.Path]::GetExtension($generatedApk) -ne '.apk' -or -not $generatedApk.StartsWith((Join-Path (Get-Location).Path 'apps/tauri/src-tauri/gen/android/app/build/outputs/apk/'))) { throw 'Generated APK path validation failed' }
if (Test-Path -LiteralPath $generatedApk -PathType Leaf) { Remove-Item -LiteralPath $generatedApk }
$arguments = @('android','build','--target','aarch64','--apk')
if (-not $Release) { $arguments += '--debug' }
& '.\node_modules\.bin\tauri.cmd' @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& (Join-Path $PSScriptRoot 'verify-android-apk.ps1') -Apk $relativeApk
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($Release) { & node scripts/sign-android-release.mjs $relativeApk }
