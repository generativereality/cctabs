$ProgressPreference = "SilentlyContinue"
$ErrorActionPreference = "Stop"
$in = "C:\Users\dev\cctabs-in"
New-Item -ItemType Directory -Force C:\tools\bin, C:\tools\cctabs | Out-Null
# Node (win-arm64 ships only as a zip)
if (-not (Test-Path C:\tools\node\node.exe)) {
  Expand-Archive "$in\node-win-arm64.zip" C:\tools -Force
  Move-Item C:\tools\node-v24.22.0-win-arm64 C:\tools\node
}
# cctabs from main, with its deps
tar -xzf "$in\cctabs-stage.tgz" -C C:\tools\cctabs
Set-Content C:\tools\bin\cctabs.cmd '@"C:\tools\node\node.exe" "C:\tools\cctabs\node_modules\@generativereality\cctabs\dist\index.js" %*' -Encoding ascii
# User PATH: node + the cctabs shim (Tabby tabs inherit the user environment)
$p = [Environment]::GetEnvironmentVariable("Path", "User")
foreach ($d in "C:\tools\node", "C:\tools\bin") { if ($p -notlike "*$d*") { $p = "$d;$p" } }
[Environment]::SetEnvironmentVariable("Path", $p, "User")
# Plugin 0.1.6 where Tabby looks for it
$pl = "$env:APPDATA\tabby\plugins"
New-Item -ItemType Directory -Force $pl | Out-Null
tar -xzf "$in\plugin-stage.tgz" -C $pl
# Tabby itself, per-user silent install
if (-not (Test-Path "$env:LOCALAPPDATA\Programs\Tabby\Tabby.exe")) {
  Start-Process "$in\tabby-setup-arm64.exe" -ArgumentList "/S" -Wait
}
"tabby: " + (Test-Path "$env:LOCALAPPDATA\Programs\Tabby\Tabby.exe")
"node: " + (& C:\tools\node\node.exe --version)
"cctabs: " + (& C:\tools\bin\cctabs.cmd --version 2>$null | Select-Object -Last 1)
"plugin: " + (Get-Content "$pl\node_modules\tabby-cctabs\package.json" -Raw | ConvertFrom-Json).version
"console user: " + (Get-CimInstance Win32_ComputerSystem).UserName
