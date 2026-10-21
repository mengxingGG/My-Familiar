param([switch]$Test, [switch]$HostProbe, [switch]$PrepareOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$toolRoot = Join-Path $projectRoot '.artifacts/android-toolchain'
$outputRoot = Join-Path $projectRoot '.artifacts/android-feishu'
$workRoot = Join-Path $outputRoot 'managed-cli'
New-Item -ItemType Directory -Force -Path $toolRoot,$outputRoot,$workRoot | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path); $hasher = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hasher.Dispose() }
}

function Get-VerifiedArchive([string]$Url, [string]$Path, [string]$Hash) {
    if (!(Test-Path -LiteralPath $Path)) { Invoke-WebRequest $Url -OutFile $Path }
    if ((Get-Sha256 $Path) -ne $Hash) { throw "Archive hash mismatch: $Path" }
}
$goArchive = Join-Path $toolRoot 'go1.27.2.windows-amd64.zip'
Get-VerifiedArchive 'https://go.dev/dl/go1.27.2.windows-amd64.zip' $goArchive '1314008898bd40df77af4b014f777f08873dbdfbcd3d92308728ee03304fe04f'
$go = Join-Path $toolRoot 'go/bin/go.exe'
if (!(Test-Path -LiteralPath $go)) { [IO.Compression.ZipFile]::ExtractToDirectory($goArchive, $toolRoot) }
$commit = 'cb5a3d704379552dc61e37898e5f74798783190d'
$cliArchive = Join-Path $toolRoot 'lark-cli-cb5a3d7.zip'
Get-VerifiedArchive "https://codeload.github.com/larksuite/cli/zip/$commit" $cliArchive '040f7c8eaa13dbd9d5201893d5092c68bd416cf75790b1c0a8d18646bee06220'
$cliSource = Join-Path $toolRoot "cli-$commit"
if (!(Test-Path -LiteralPath $cliSource)) { [IO.Compression.ZipFile]::ExtractToDirectory($cliArchive, $toolRoot) }

# 只在构建目录生成模块替换与嵌入资源，不修改官方源码或用户全局 Go 环境。
Copy-Item -Path (Join-Path $projectRoot 'plugins/feishu-android/cli/*.go') -Destination $workRoot -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'plugins/feishu-android/cli/policy_cases_test.json') -Destination $workRoot -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'plugins/feishu-android/cli/go.mod') -Destination $workRoot -Force
Copy-Item -LiteralPath (Join-Path $cliSource 'go.sum') -Destination $workRoot -Force
foreach ($tree in @('skills','affordance')) {
    if (!(Test-Path -LiteralPath (Join-Path $workRoot $tree))) { Copy-Item -LiteralPath (Join-Path $cliSource $tree) -Destination $workRoot -Recurse }
}
Copy-Item -LiteralPath (Join-Path $cliSource 'LICENSE') -Destination (Join-Path $outputRoot 'LARK-CLI-LICENSE') -Force
$env:GOPATH = Join-Path $toolRoot 'go-work'
$env:GOCACHE = Join-Path $toolRoot 'go-cache'
$env:GOTOOLCHAIN = 'local'
& $go -C $workRoot mod edit "-replace=github.com/larksuite/cli=$cliSource"
if($LASTEXITCODE){throw 'Go module preparation failed'}
if($PrepareOnly){ return }
$env:GOOS='windows'; $env:GOARCH='amd64'; $env:CGO_ENABLED='0'
if ($Test) {
    & $go -C $workRoot test -mod=mod -count=1 -v .
    if($LASTEXITCODE){throw 'Managed CLI tests failed'}
}
if ($HostProbe) {
    $probeRoot = Join-Path $projectRoot '.artifacts/android-unicode'
    New-Item -ItemType Directory -Force -Path $probeRoot | Out-Null
    & $go -C $workRoot build -mod=mod -trimpath -o (Join-Path $probeRoot 'host-cli.exe') .
    if($LASTEXITCODE){throw 'Windows CLI comparison build failed'}
}
$sdkRoot = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { 'C:/AndroidSDK' }
$clang = Join-Path $sdkRoot 'ndk/27.0.12077973/toolchains/llvm/prebuilt/windows-x86_64/bin/clang.exe'
if (!(Test-Path -LiteralPath $clang)) { throw 'Android NDK 27.0.12077973 is required' }
$env:GOOS='android'; $env:GOARCH='arm64'; $env:CGO_ENABLED='1'
$env:CC='"' + $clang + '" --target=aarch64-linux-android28'
$binary = Join-Path $outputRoot 'libfamiliar_lark.so'
& $go -C $workRoot build -mod=mod -trimpath -ldflags '-s -w -X github.com/larksuite/cli/internal/build.Version=1.0.96-familiar -extldflags=-Wl,-z,max-page-size=16384' -o $binary .
if($LASTEXITCODE){throw 'Android ARM64 Feishu build failed'}
$readElf = Join-Path (Split-Path -Parent $clang) 'llvm-readelf.exe'
$header = (& $readElf -h -l $binary) -join "`n"
if($header -notmatch 'Machine:\s+AArch64' -or $header -notmatch '/system/bin/linker64'){throw 'Expected Android ARM64 executable'}
foreach($line in ($header -split "`n" | Where-Object {$_ -match '^\s*LOAD\s'})) {
    $alignment=[Convert]::ToInt64(($line.Trim() -split '\s+')[-1].Substring(2),16)
    if($alignment -lt 16384){throw 'ELF segment is not 16 KiB aligned'}
}
$evidence=@{upstreamVersion='1.0.96';upstreamCommit=$commit;go='1.27.2';ndk='27.0.12077973';abi='arm64-v8a';minSdk=28;alignment=16384;bytes=(Get-Item -LiteralPath $binary).Length;sha256=(Get-Sha256 $binary);binary=$binary}
$evidence | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $outputRoot 'managed-build.json')
$packageRoot = Join-Path $outputRoot 'jniLibs/arm64-v8a'
New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null
Copy-Item -LiteralPath $binary -Destination (Join-Path $packageRoot 'libfamiliar_lark.so') -Force
Write-Output "Android ARM64 managed CLI built: $binary"
