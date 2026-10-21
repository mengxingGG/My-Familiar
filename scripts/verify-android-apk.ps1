param([Parameter(Mandatory=$true)][string]$Apk)
$ErrorActionPreference = 'Stop'
function Get-OfficeAssetHash([string]$Path) {
    $officeHashStream = [IO.File]::OpenRead($Path); $officeHashAlgorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($officeHashAlgorithm.ComputeHash($officeHashStream)).Replace('-', '').ToLowerInvariant() }
    finally { $officeHashStream.Dispose(); $officeHashAlgorithm.Dispose() }
}
$projectRoot = Split-Path -Parent $PSScriptRoot
$artifactRoot = Join-Path $projectRoot '.artifacts/android-device'
$libraryRoot = Join-Path $artifactRoot 'apk-libraries'
New-Item -ItemType Directory -Force -Path $libraryRoot | Out-Null
$sdkRoot = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { 'C:\AndroidSDK' }
$readElf = Join-Path $sdkRoot 'ndk/27.0.12077973/toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-readelf.exe'
$zipalign = Join-Path $sdkRoot 'build-tools/36.0.0/zipalign.exe'
$apkPath = (Resolve-Path -LiteralPath $Apk).Path
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($apkPath)
$libraries = @()
$officeFiles = @()
$wakeFiles = @()
$wakeEncoderFiles = @()
try {
    $officeRoot = Join-Path $projectRoot '.artifacts/android-feishu-wasm/assets'
    $officeManifest = Get-Content -LiteralPath (Join-Path $officeRoot 'manifest.json') -Raw | ConvertFrom-Json
    if ($officeManifest.engine -cne 'go-js-wasm' -or $officeManifest.go -cne '1.27.2' -or $officeManifest.upstreamCommit -cne 'cb5a3d704379552dc61e37898e5f74798783190d') { throw 'APK 办公构建来源不符' }
    $expectedOfficeFiles = @('official-cli.wasm','wasm_exec.js','worker.cjs','filesystem.cjs','GO-LICENSE','LARK-CLI-LICENSE')
    if ((@($officeManifest.files.name | Sort-Object) -join ',') -cne (($expectedOfficeFiles | Sort-Object) -join ',')) { throw '办公执行器构建清单不符' }
    $actualOfficeFiles = @($archive.Entries | Where-Object { $_.FullName -like 'assets/runtime/feishu/*' -and -not $_.FullName.EndsWith('/') } | ForEach-Object { $_.FullName.Substring('assets/runtime/feishu/'.Length) })
    if ((($actualOfficeFiles | Sort-Object) -join ',') -cne ((@($expectedOfficeFiles) + @('manifest.json') | Sort-Object) -join ',')) { throw 'APK 办公资源清单不符' }
    foreach ($officeFile in @($officeManifest.files) + @([PSCustomObject]@{name='manifest.json';bytes=(Get-Item -LiteralPath (Join-Path $officeRoot 'manifest.json')).Length;sha256=(Get-OfficeAssetHash (Join-Path $officeRoot 'manifest.json'))})) {
        $officeEntry = $archive.GetEntry("assets/runtime/feishu/$($officeFile.name)")
        if (-not $officeEntry -or $officeEntry.Length -ne $officeFile.bytes) { throw "APK 办公资源缺失或长度不符：$($officeFile.name)" }
        $officeStream = $officeEntry.Open(); $officeHasher = [Security.Cryptography.SHA256]::Create()
        try { $officeHash = [BitConverter]::ToString($officeHasher.ComputeHash($officeStream)).Replace('-', '').ToLowerInvariant() } finally { $officeStream.Dispose(); $officeHasher.Dispose() }
        if ($officeHash -cne $officeFile.sha256) { throw "APK 办公资源摘要不符：$($officeFile.name)" }
        $officeFiles += [PSCustomObject]@{name=$officeFile.name;bytes=$officeEntry.Length;sha256=$officeHash}
    }
    if (@($archive.Entries | Where-Object { $_.FullName -like 'assets/wake-fixtures/*' }).Count) { throw '测试录音不应进入交付 APK' }
    $wakeManifest = $archive.GetEntry('assets/wake/manifest.json')
    if (-not $wakeManifest) { throw 'APK 缺少离线关键词模型清单' }
    $reader = New-Object IO.StreamReader($wakeManifest.Open())
    try { $wakeInfo = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    $expectedWakeFiles = @('encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt','empty-keywords.txt')
    $actualWakeNames = ($wakeInfo.files.file | Sort-Object) -join ','
    $expectedWakeNames = ($expectedWakeFiles | Sort-Object) -join ','
    if ($actualWakeNames -cne $expectedWakeNames) { throw 'APK 离线关键词文件清单不符' }
    foreach ($file in $wakeInfo.files) {
        $entry = $archive.GetEntry("assets/wake/$($file.file)")
        if (-not $entry -or $entry.Length -ne $file.bytes) { throw "APK 模型缺失或长度不符：$($file.file)" }
        $stream = $entry.Open(); $sha = [Security.Cryptography.SHA256]::Create()
        try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $stream.Dispose(); $sha.Dispose() }
        if ($hash -cne $file.sha256) { throw "APK 模型摘要不符：$($file.file)" }
        $wakeFiles += [PSCustomObject]@{name=$file.file; bytes=$entry.Length; sha256=$hash}
    }
    $encoderHashes = @{
        'tokens.txt' = '2d3f32311f9b692b964da3c90e830258d3e78e013cb0c992dbfb15cd5a1a71b0'
        'en.phone' = 'f7000ec3a90544c0c7c16090d8951779c2b322e14dad5006290f498567d439ea'
        'PINYIN-PRO-LICENSE' = '824f6069c5a59b0c1650d0fb9f8d091866c6019eb761c8e658dfc03f001eabd2'
    }
    foreach ($name in $encoderHashes.Keys) {
        $entry = $archive.GetEntry("assets/runtime/wake/$name")
        if (-not $entry) { throw "APK 缺少唤醒词编码资源：$name" }
        $stream = $entry.Open(); $sha = [Security.Cryptography.SHA256]::Create()
        try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $stream.Dispose(); $sha.Dispose() }
        if ($hash -cne $encoderHashes[$name]) { throw "APK 唤醒词编码资源摘要不符：$name" }
        $wakeEncoderFiles += [PSCustomObject]@{name=$name; bytes=$entry.Length; sha256=$hash}
    }
    $entries = @($archive.Entries | Where-Object { $_.FullName -match '^lib/.+\.so$' })
    if ($entries.Count -eq 0) { throw 'APK 不含原生库' }
    foreach ($entry in $entries) {
        if ($entry.FullName -notmatch '^lib/arm64-v8a/[^/]+\.so$') { throw "非 ARM64 库：$($entry.FullName)" }
        $name = [IO.Path]::GetFileName($entry.FullName)
        $target = Join-Path $libraryRoot $name
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
        $header = & $readElf -h $target
        if ($LASTEXITCODE -ne 0 -or ($header -join "`n") -notmatch 'Machine:\s+AArch64') { throw "非 AArch64 ELF：$name" }
        $segments = @(& $readElf -l $target | Select-String '^\s*LOAD\s')
        if ($segments.Count -eq 0) { throw "缺少 LOAD 段：$name" }
        foreach ($segment in $segments) {
            $alignment = [Convert]::ToInt64(($segment.Line.Trim() -split '\s+')[-1].Substring(2), 16)
            if ($alignment -lt 16384) { throw "未达到 16 KB 页对齐：$name" }
        }
        $needed = @(& $readElf -d $target | Select-String 'NEEDED' | ForEach-Object { if ($_.Line -match '\[(.+?)\]') { $Matches[1] } })
        $libraries += [PSCustomObject]@{name=$name; bytes=$entry.Length; architecture='AArch64'; loadAlignmentAtLeast=16384; needed=$needed}
    }
} finally { $archive.Dispose() }
$required = @('libfamiliar_mobile_lib.so','libfamiliar_runtime.so','libnode.so','libc++_shared.so','libsherpa-onnx-jni.so','libonnxruntime.so','libfamiliar_workspace.so')
foreach ($name in $required) { if ($name -notin $libraries.name) { throw "APK 缺少运行库：$name" } }
if ('libfamiliar_lark.so' -in $libraries.name) { throw 'APK 不应混入旧的 Go 原生执行路径' }
$workspaceLibrary = $libraries | Where-Object { $_.name -ceq 'libfamiliar_workspace.so' }
if ('libc.so' -notin $workspaceLibrary.needed -or 'libnode.so' -notin $workspaceLibrary.needed) { throw '工作区代理必须使用动态 Android 运行库' }
$systemLibraries = @('libc.so','libm.so','libdl.so','liblog.so','libandroid.so','libz.so')
foreach ($library in $libraries) {
    foreach ($dependency in $library.needed) {
        if ($dependency -notin $libraries.name -and $dependency -notin $systemLibraries) { throw "未打包的依赖：$($library.name) -> $dependency" }
    }
}
& $zipalign -c -P 16 4 $apkPath
if ($LASTEXITCODE -ne 0) { throw 'APK ZIP 16 KB 对齐检查失败' }
$hashStream = [IO.File]::OpenRead($apkPath)
$hasher = [Security.Cryptography.SHA256]::Create()
try { $sha256 = [BitConverter]::ToString($hasher.ComputeHash($hashStream)).Replace('-', '').ToLowerInvariant() }
finally { $hashStream.Dispose(); $hasher.Dispose() }
$evidence = [PSCustomObject]@{apk=$apkPath; sha256=$sha256; bytes=(Get-Item -LiteralPath $apkPath).Length; abi='arm64-v8a'; zipAlignment16kb=$true; libraries=$libraries; keywordModel=$wakeFiles; keywordEncoder=$wakeEncoderFiles;officeEngine='go-js-wasm';officeAssets=$officeFiles}
[IO.File]::WriteAllText((Join-Path $artifactRoot 'apk-verification.json'), ($evidence | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
Write-Output "ARM64 APK 验证通过：$($libraries.Count) 个原生库，依赖完整，ELF / ZIP 16 KB 对齐。"
