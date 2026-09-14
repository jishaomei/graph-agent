param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$Sandbox,
  [Parameter(Mandatory = $true)][string]$Server,
  [Parameter(Mandatory = $true)][string]$Secret,
  [Parameter(Mandatory = $true)][string]$NodePath,
  [string]$Mode = 'existing'
)

$ErrorActionPreference = 'Stop'
$env:HOME = Join-Path $Sandbox 'home'
$env:USERPROFILE = $env:HOME
$env:APPDATA = Join-Path $Sandbox 'appdata'
$env:USERNAME = 'sandbox-user'
$env:PROCESSOR_ARCHITECTURE = 'AMD64'
$env:PATH = "sandbox-original-path"
$env:WORK_DIR = 'inherited-work-dir'
$env:YEAFT_DIR = 'inherited-yeaft-dir'
$env:SERVER_URL = 'inherited-server'
$env:AGENT_SECRET = 'inherited-secret'
$env:PM2_HOME = 'existing-pm2-home'
New-Item -ItemType Directory -Force -Path $env:HOME, $env:APPDATA | Out-Null
$OriginalPath = $env:PATH
$OriginalWorkDir = $env:WORK_DIR
$OriginalYeaftDir = $env:YEAFT_DIR
$OriginalServer = $env:SERVER_URL
$OriginalSecret = $env:AGENT_SECRET
$script:AclCalled = $false

function Get-Command {
  param([string]$Name, [Parameter(ValueFromRemainingArguments = $true)]$Rest)
  if ($Name -eq 'node.exe' -or $Name -eq 'node') {
    if ($Mode -ne 'existing') { return $null }
    return [pscustomobject]@{ Source = $NodePath }
  }
  if ($Name -eq 'npm.cmd' -or $Name -eq 'npm') { return [pscustomobject]@{ Source = 'Invoke-MockNpm' } }
  Microsoft.PowerShell.Core\Get-Command $Name @Rest
}
function icacls.exe {
  $script:AclCalled = $true
  $global:LASTEXITCODE = 0
}
function Invoke-MockNpm {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  if ($Arguments.Count -eq 1 -and $Arguments[0] -eq '--version') { $global:LASTEXITCODE = 0; return }
  $PrefixIndex = [Array]::IndexOf($Arguments, '--prefix')
  if ($PrefixIndex -lt 0) { $global:LASTEXITCODE = 2; return }
  $Prefix = $Arguments[$PrefixIndex + 1]
  $Cli = Join-Path $Prefix 'node_modules\@yeaft\webchat-agent\cli.js'
  $Pm2 = Join-Path $Prefix 'node_modules\pm2\bin\pm2'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Cli), (Split-Path -Parent $Pm2) | Out-Null
  Set-Content -LiteralPath $Pm2 -Value '# mock pm2'
  Set-Content -LiteralPath $Cli -Encoding UTF8 -Value @'
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const value = key => args[args.indexOf(key) + 1];
const name = value('--name');
const startup = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `yeaft-agent-${name}.bat`);
fs.mkdirSync(path.dirname(startup), { recursive: true });
fs.writeFileSync(startup, '@echo off\r\npm2 resurrect\r\nstart "" powershell -File "C:\\mock\\agent-tray.ps1"\r\n');
fs.writeFileSync(path.join(process.env.APPDATA, 'cli-capture.json'), JSON.stringify({
  args,
  secret: process.env.AGENT_SECRET,
  server: process.env.SERVER_URL,
  workDir: process.env.WORK_DIR,
  yeaftDir: process.env.YEAFT_DIR,
  runtimePath: process.env.PATH,
}));
'@
  $global:LASTEXITCODE = 0
}

function Invoke-WebRequest {
  param([switch]$UseBasicParsing, $MaximumRedirection, [string]$Uri, [string]$OutFile)
  if ($Uri -match 'SHASUMS256.txt$') {
    $Hash = if ($Mode -eq 'bad-checksum') { '0' * 64 } else { 'a' * 64 }
    Set-Content -LiteralPath $OutFile -Value "$Hash  node-v24.9.0-win-x64.zip"
  } else { Set-Content -LiteralPath $OutFile -Value 'mock-zip' }
}
function Get-FileHash { param($Algorithm, $LiteralPath) return @{ Hash = 'a' * 64 } }
function Expand-Archive {
  param($LiteralPath, $DestinationPath)
  $Folder = Join-Path $DestinationPath 'node-v24.9.0-win-x64'
  New-Item -ItemType Directory -Force -Path $Folder | Out-Null
  New-Item -ItemType SymbolicLink -Path (Join-Path $Folder 'node.exe') -Target $NodePath | Out-Null
  # The fixture uses a real Node process for CLI argv; npm download/install is mocked.
  $NpmFile = Join-Path $Folder 'node_modules/npm/bin/npm-cli.js'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $NpmFile) | Out-Null
  Set-Content -LiteralPath $NpmFile -Value ''
}
# Intercept the downloaded npm CLI only; the real Node still validates/runs the Agent CLI.
function Move-Item {
  param($LiteralPath, $Destination)
  Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination
  if ($Mode -eq 'download') {
    $NpmFile = Join-Path $Destination 'node_modules/npm/bin/npm-cli.js'
    Invoke-MockNpm --prefix (Split-Path -Parent $Destination) install
  }
}
. $Installer -Server $Server -Secret $Secret
$Capture = Get-Content -LiteralPath (Join-Path $env:APPDATA 'cli-capture.json') -Raw | ConvertFrom-Json
$Installation = Get-ChildItem -LiteralPath (Join-Path $env:HOME '.yeaft\installations') -Directory | Select-Object -First 1
$Startup = Get-ChildItem -LiteralPath $env:APPDATA -Recurse -File | Where-Object Name -like 'yeaft-agent-*.bat' | Select-Object -First 1
$StartupText = Get-Content -LiteralPath $Startup.FullName -Raw
[pscustomobject]@{
  aclCalled = $script:AclCalled
  complete = Test-Path -LiteralPath (Join-Path $Installation.FullName '.complete')
  manager = Test-Path -LiteralPath (Join-Path $Installation.FullName 'yeaft-agent.ps1')
  secretMatched = $Capture.secret -ceq $Secret
  secretInArgs = @($Capture.args) -contains $Secret
  serverMatched = $Capture.server -ceq $Server
  explicitWorkDir = $Capture.workDir -ceq (Join-Path $Installation.FullName 'workspace')
  explicitYeaftDir = $Capture.yeaftDir -ceq (Join-Path $Installation.FullName 'data')
  pm2Restored = $env:PM2_HOME -ceq 'existing-pm2-home'
  startupPrivatePm2 = $StartupText -match 'PM2_HOME='
  managerPrivatePath = (Get-Content -LiteralPath (Join-Path $Installation.FullName 'yeaft-agent.ps1') -Raw) -match 'PM2_HOME'
  upgradeResolvesPm2 = @($Capture.runtimePath -split ';') -contains $Installation.FullName
  startupAbsoluteNode = $StartupText -match [regex]::Escape($NodePath)
  startupAbsolutePm2 = $StartupText -match 'node_modules[\\/]pm2[\\/]bin[\\/]pm2'
  startupTrayPreserved = $StartupText -match 'agent-tray\.ps1'
  pathRestored = $env:PATH -ceq $OriginalPath
  workDirRestored = $env:WORK_DIR -ceq $OriginalWorkDir
  yeaftDirRestored = $env:YEAFT_DIR -ceq $OriginalYeaftDir
  serverRestored = $env:SERVER_URL -ceq $OriginalServer
  secretRestored = $env:AGENT_SECRET -ceq $OriginalSecret
} | ConvertTo-Json -Compress
