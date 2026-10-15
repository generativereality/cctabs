$ProgressPreference = "SilentlyContinue"
$exe = "$env:LOCALAPPDATA\Programs\Tabby\Tabby.exe"
$name = "cctabs-start-tabby"
$a = New-ScheduledTaskAction -Execute $exe
$p = New-ScheduledTaskPrincipal -UserId "dev" -LogonType Interactive
Register-ScheduledTask -TaskName $name -Action $a -Principal $p -Force | Out-Null
try { Start-ScheduledTask -TaskName $name } finally { Unregister-ScheduledTask -TaskName $name -Confirm:$false }
$ok = $false
for ($i = 0; $i -lt 60 -and -not $ok; $i++) {
  Start-Sleep 2
  try { $h = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:3300/api/health; $ok = $true; "health: " + $h.Content } catch {}
}
if (-not $ok) { "plugin did not answer in 120s" }
"tabby processes: " + (Get-CimInstance Win32_Process -Filter "Name='Tabby.exe'" | Measure-Object).Count
