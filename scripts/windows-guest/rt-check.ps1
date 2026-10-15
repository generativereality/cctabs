$ProgressPreference = "SilentlyContinue"
"--- rt.log (the command)"; Get-Content C:\Users\dev\rt.log -ErrorAction SilentlyContinue | ForEach-Object { $_ -replace '[^\x20-\x7E]','?' }
$l = Get-ChildItem "$env:USERPROFILE\.config\cctabs\fleet\restart-*.log" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
"--- worker log " + $l.Name; Get-Content $l.FullName -ErrorAction SilentlyContinue
"--- now"
try { "health: " + (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://127.0.0.1:3300/api/health).Content } catch { "health: down" }
try { ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 http://127.0.0.1:3300/api/tabs).Content | ConvertFrom-Json).tabs | ForEach-Object { "tab: " + $_.title } } catch { "tabs: n/a" }
"tabby procs: " + (Get-CimInstance Win32_Process -Filter "Name='Tabby.exe'" | Measure-Object).Count
"pending: " + (Test-Path "$env:USERPROFILE\.config\cctabs\fleet\pending-restore.json")
