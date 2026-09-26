$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$editorUrl = 'http://localhost:5173'
$apiUrl = 'http://localhost:3001/api/health'

Set-Location -LiteralPath $projectRoot
$Host.UI.RawUI.WindowTitle = 'H5 SCORM Editor - 一键启动'

function Test-EditorRunning {
    try {
        $page = Invoke-WebRequest -UseBasicParsing -Uri $editorUrl -TimeoutSec 2
        $api = Invoke-WebRequest -UseBasicParsing -Uri $apiUrl -TimeoutSec 2
        return $page.StatusCode -ge 200 -and $api.StatusCode -eq 200
    }
    catch {
        return $false
    }
}

function Wait-BeforeExit {
    Write-Host ''
    Write-Host '按任意键关闭窗口……' -ForegroundColor DarkGray
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
}

Clear-Host
Write-Host '========================================' -ForegroundColor DarkCyan
Write-Host '          H5 SCORM Editor' -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor DarkCyan
Write-Host ''

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host '[错误] 未检测到 Node.js。' -ForegroundColor Red
    Write-Host '请先安装 Node.js 20 或更高版本：https://nodejs.org/'
    Wait-BeforeExit
    exit 1
}

if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    Write-Host '[错误] 未检测到 npm，请重新安装 Node.js。' -ForegroundColor Red
    Wait-BeforeExit
    exit 1
}

$nodeVersion = & node --version
Write-Host "[环境] Node.js $nodeVersion" -ForegroundColor DarkGray

if (Test-EditorRunning) {
    Write-Host '[状态] 编辑器已经在运行。' -ForegroundColor Green
    if ($env:H5_EDITOR_SKIP_BROWSER -ne '1') {
        Start-Process $editorUrl
    }
    exit 0
}

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\.package-lock.json'))) {
    Write-Host '[准备] 首次运行，正在安装项目依赖……' -ForegroundColor Yellow
    Write-Host '       这一步可能需要几分钟，请保持网络连接。' -ForegroundColor DarkGray
    & npm.cmd install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        Write-Host '[错误] 依赖安装失败，请检查网络后重试。' -ForegroundColor Red
        Wait-BeforeExit
        exit $LASTEXITCODE
    }
    Write-Host '[完成] 项目依赖安装完成。' -ForegroundColor Green
    Write-Host ''
}

Write-Host '[启动] 正在启动前端和后端服务……' -ForegroundColor Cyan
Write-Host "[地址] $editorUrl" -ForegroundColor White
Write-Host '[停止] 如需停止编辑器，请在本窗口按 Ctrl+C。' -ForegroundColor DarkGray
Write-Host ''

$skipBrowser = $env:H5_EDITOR_SKIP_BROWSER -eq '1'
$monitorCode = @"
`$editorUrl = '$editorUrl'
`$apiUrl = '$apiUrl'
`$skipBrowser = `$$($skipBrowser.ToString().ToLowerInvariant())
for (`$attempt = 0; `$attempt -lt 120; `$attempt++) {
    try {
        `$page = Invoke-WebRequest -UseBasicParsing -Uri `$editorUrl -TimeoutSec 2
        `$api = Invoke-WebRequest -UseBasicParsing -Uri `$apiUrl -TimeoutSec 2
        if (`$page.StatusCode -ge 200 -and `$api.StatusCode -eq 200) {
            if (-not `$skipBrowser) { Start-Process `$editorUrl }
            exit 0
        }
    }
    catch {}
    Start-Sleep -Seconds 1
}
exit 1
"@

$encodedMonitor = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($monitorCode))
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile', '-EncodedCommand', $encodedMonitor

& npm.cmd run dev
$runExitCode = $LASTEXITCODE

if ($runExitCode -ne 0) {
    Write-Host ''
    Write-Host '[提示] 服务已停止，或启动过程中遇到错误。' -ForegroundColor Yellow
    Wait-BeforeExit
}

exit $runExitCode
