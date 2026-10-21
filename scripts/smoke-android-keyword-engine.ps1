param([string]$Serial = 'emulator-5554')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'android-env.ps1')
Set-Location (Split-Path -Parent $PSScriptRoot)
$adb = Join-Path $env:ANDROID_HOME 'platform-tools/adb.exe'
$log = Join-Path $PWD '.artifacts/android-device/wake-engine-device.log'
$buildLog = Join-Path $PWD '.artifacts/android-device/wake-kotlin-test-build.log'
$apk = Join-Path $PWD 'plugins/platform-android/android/build/outputs/apk/androidTest/debug/tauri-plugin-familiar-android-debug-androidTest.apk'
$testPackage = 'app.familiar.platform.test'
& node scripts/prepare-android-wake.mjs --fixtures
if ($LASTEXITCODE -ne 0) { throw '关键词测试资源准备失败' }
& './apps/tauri/src-tauri/gen/android/gradlew.bat' -p './apps/tauri/src-tauri/gen/android' :tauri-plugin-familiar-android:assembleDebugAndroidTest --console=plain *> $buildLog
if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath $buildLog -Tail 40; throw '关键词测试构建失败' }
$installed = $false
try {
    & $adb -s $Serial install -r $apk
    if ($LASTEXITCODE -ne 0) { throw '关键词测试 APK 安装失败' }
    $installed = $true
    & $adb -s $Serial shell am instrument -w -r -e class app.familiar.platform.OfflineKeywordDetectorTest "$testPackage/androidx.test.runner.AndroidJUnitRunner" *> $log
    if ($LASTEXITCODE -ne 0) { throw '关键词设备测试进程失败' }
    $output = Get-Content -LiteralPath $log -Raw
    if ($output -notmatch 'OK \(4 tests\)' -or $output -match 'FAILURES|INSTRUMENTATION_FAILED|Process crashed') { Get-Content -LiteralPath $log -Tail 50; throw '关键词设备测试未通过' }
    $evidence = [PSCustomObject]@{
        serial=$Serial; testApk=$apk; testApkSha256=(Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
        suites=4; source='official prerecorded sample replay'; microphoneOpened=$false
        assertions=@('Chinese and English model inference with Node library loaded','keyword replacement without hidden defaults','24 kHz resampling and silence','cancellation and repeated release','bounded input and rate continuity','native keyword syntax isolation','single thread ownership')
    }
    [IO.File]::WriteAllText((Join-Path $PWD '.artifacts/android-device/wake-engine-smoke.json'), ($evidence | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
    Write-Output '离线关键词引擎设备验收通过：4 组；官方录音回放，未开启麦克风。'
} finally {
    if ($installed) {
        & $adb -s $Serial uninstall $testPackage
        if ($LASTEXITCODE -ne 0) { throw '测试包清理失败，请检查模拟器' }
    }
}
