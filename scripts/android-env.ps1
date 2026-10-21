$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$toolRoot = Join-Path $projectRoot '.artifacts/android-toolchain'
# 优先保留开发者环境；本仓库已准备的独立工具链仍可直接复用。
$cachedRust = Join-Path $toolRoot 'rustup'
$cachedCargo = Join-Path $toolRoot 'cargo'
if (Test-Path -LiteralPath (Join-Path $cachedRust 'settings.toml')) { $env:RUSTUP_HOME = $cachedRust }
if (Test-Path -LiteralPath (Join-Path $cachedCargo 'bin')) { $env:CARGO_HOME = $cachedCargo }
if (-not $env:JAVA_HOME) {
    $knownJava = 'C:\Program Files\Java\jdk-17.0.2'
    if (Test-Path -LiteralPath $knownJava) { $env:JAVA_HOME = $knownJava }
    else { throw 'Set JAVA_HOME to a JDK 17+ installation.' }
}
if (-not $env:ANDROID_HOME) {
    if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_HOME = $env:ANDROID_SDK_ROOT }
    elseif (Test-Path -LiteralPath 'C:\AndroidSDK') { $env:ANDROID_HOME = 'C:\AndroidSDK' }
    else { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
}
if (-not $env:NDK_HOME) { $env:NDK_HOME = Join-Path $env:ANDROID_HOME 'ndk/27.0.12077973' }
if (-not (Test-Path -LiteralPath $env:NDK_HOME)) { throw 'Install Android NDK 27.0.12077973 or set NDK_HOME.' }
$extraPaths = @((Join-Path $env:JAVA_HOME 'bin'), (Join-Path $env:ANDROID_HOME 'platform-tools'))
if ($env:CARGO_HOME) { $extraPaths += (Join-Path $env:CARGO_HOME 'bin') }
$gnuLinker = if ($env:RUSTUP_HOME) { Join-Path $env:RUSTUP_HOME 'toolchains/stable-x86_64-pc-windows-gnu/lib/rustlib/x86_64-pc-windows-gnu/bin/rust-lld.exe' } else { '' }
if ($gnuLinker -and (Test-Path -LiteralPath $gnuLinker)) {
    $hostTools = Join-Path $toolRoot 'host-bin'
    New-Item -ItemType Directory -Force -Path $hostTools | Out-Null
    Copy-Item -LiteralPath (Join-Path $env:NDK_HOME 'toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-dlltool.exe') -Destination (Join-Path $hostTools 'dlltool.exe') -Force
    $extraPaths += $hostTools
    $env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = $gnuLinker
}
$env:PATH = ($extraPaths -join ';') + ';' + $env:PATH
