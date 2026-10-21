$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot
& (Join-Path $PSScriptRoot 'build-android-feishu.ps1') -PrepareOnly
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node scripts/prepare-android-feishu-wasm.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$toolRoot = Join-Path $projectRoot '.artifacts/android-toolchain'
$outputRoot = Join-Path $projectRoot '.artifacts/android-feishu-wasm'
$assetRoot = Join-Path $outputRoot 'assets'
function Get-WasmAssetHash([string]$Path) {
    $wasmHashStream = [IO.File]::OpenRead($Path); $wasmHashAlgorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($wasmHashAlgorithm.ComputeHash($wasmHashStream)).Replace('-', '').ToLowerInvariant() }
    finally { $wasmHashStream.Dispose(); $wasmHashAlgorithm.Dispose() }
}
New-Item -ItemType Directory -Force -Path $assetRoot | Out-Null
$env:GOROOT = Join-Path $toolRoot 'go'
$env:GOPATH = Join-Path $toolRoot 'go-work'
$env:GOCACHE = Join-Path $toolRoot 'go-cache'
$env:GOTOOLCHAIN = 'local'
$env:GOOS = 'js'
$env:GOARCH = 'wasm'
$env:CGO_ENABLED = '0'
& (Join-Path $env:GOROOT 'bin/go.exe') -C (Join-Path $outputRoot 'cli-work') build -overlay (Join-Path $outputRoot 'overlay.json') -mod=mod -trimpath -ldflags '-s -w -X github.com/larksuite/cli/internal/build.Version=1.0.96-familiar' -o (Join-Path $assetRoot 'official-cli.wasm') .
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Copy-Item -LiteralPath (Join-Path $env:GOROOT 'lib/wasm/wasm_exec.js') -Destination (Join-Path $assetRoot 'wasm_exec.js') -Force
Copy-Item -LiteralPath (Join-Path $env:GOROOT 'LICENSE') -Destination (Join-Path $assetRoot 'GO-LICENSE') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot '.artifacts/android-feishu/LARK-CLI-LICENSE') -Destination (Join-Path $assetRoot 'LARK-CLI-LICENSE') -Force
foreach ($name in @('worker.cjs','filesystem.cjs')) { Copy-Item -LiteralPath (Join-Path $projectRoot "plugins/feishu-android/wasm/$name") -Destination (Join-Path $assetRoot $name) -Force }
$wasmManifestFiles = @('official-cli.wasm','wasm_exec.js','worker.cjs','filesystem.cjs','GO-LICENSE','LARK-CLI-LICENSE') | ForEach-Object {
    $wasmAsset = Join-Path $assetRoot $_
    [PSCustomObject]@{name=$_; bytes=(Get-Item -LiteralPath $wasmAsset).Length; sha256=(Get-WasmAssetHash $wasmAsset)}
}
@{upstreamVersion='1.0.96';upstreamCommit='cb5a3d704379552dc61e37898e5f74798783190d';go='1.27.2';engine='go-js-wasm';files=@($wasmManifestFiles)} | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $assetRoot 'manifest.json')
Write-Output "Official office Wasm assets built: $assetRoot"
