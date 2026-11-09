# Carl installer for Windows:  irm https://github.com/michael-berardi/carl/releases/latest/download/install.ps1 | iex
# Carl runs shell tools through bash, so on Windows it lives inside WSL (Windows Subsystem for Linux). This script finds
# your default WSL distribution and runs the Linux installer in it, checking its SHA-256 first. If WSL is missing it says so
# and stops; install it once with `wsl --install` (restart), then run this again.
$ErrorActionPreference = 'Stop'
$base = if ($env:CARL_RELEASE_BASE) { $env:CARL_RELEASE_BASE } elseif ($env:CARL_VERSION) { "https://github.com/michael-berardi/carl/releases/download/v$($env:CARL_VERSION.TrimStart('v'))" } else { 'https://github.com/michael-berardi/carl/releases/latest/download' }

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
  throw 'Carl on Windows runs inside WSL, which is not installed. Run `wsl --install` in an administrator PowerShell, restart, then run this installer again.'
}
& wsl.exe --status *> $null
& wsl.exe -e true *> $null
if ($LASTEXITCODE -ne 0) {
  throw 'WSL is installed but has no Linux distribution that starts. Run `wsl --install -d Ubuntu`, open Ubuntu once to finish its setup, then run this installer again.'
}

$saved = @{ WSLENV = $env:WSLENV; Base = $env:CARL_RELEASE_BASE; EAP = $ErrorActionPreference }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("carl-install-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Invoke-WebRequest "$base/install.sh" -OutFile (Join-Path $tmp 'install.sh') -UseBasicParsing
  Invoke-WebRequest "$base/SHA256SUMS" -OutFile (Join-Path $tmp 'SHA256SUMS') -UseBasicParsing
  $want = (Get-Content (Join-Path $tmp 'SHA256SUMS') | Where-Object { $_ -match '\sinstall\.sh$' } | Select-Object -First 1) -split '\s+' | Select-Object -First 1
  $got = (Get-FileHash (Join-Path $tmp 'install.sh') -Algorithm SHA256).Hash.ToLower()
  if (-not $want -or $got -ne $want.ToLower()) { throw 'install.sh does not match its checksum; nothing was installed.' }
  $linuxPath = (& wsl.exe -e wslpath -a ((Join-Path $tmp 'install.sh') -replace '\\', '/')).Trim()
  $env:WSLENV = if ($saved.WSLENV) { "CARL_RELEASE_BASE/u:$($saved.WSLENV)" } else { 'CARL_RELEASE_BASE/u' }
  $env:CARL_RELEASE_BASE = $base
  & wsl.exe -e sh $linuxPath
  if ($LASTEXITCODE -ne 0) { throw "The Linux installer failed (exit $LASTEXITCODE)." }
  Write-Host 'Carl is installed in WSL. Open your Linux terminal (or run `wsl`) and run: carl setup'
} finally {
  $env:WSLENV = $saved.WSLENV; $env:CARL_RELEASE_BASE = $saved.Base; $ErrorActionPreference = $saved.EAP
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
