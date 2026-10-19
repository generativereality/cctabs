$ProgressPreference = "SilentlyContinue"
$tok = try { (Get-Content "$env:USERPROFILE\.cctabs\control-token" -ErrorAction Stop).Trim() } catch { "" }
$auth = @{ Authorization = "Bearer $tok" }  # tabby-cctabs 0.2.0+ needs the control token
Remove-Item C:\Users\dev\rt.log -ErrorAction SilentlyContinue
$body = @{ cwd = "C:\Users\dev"; title = "rt-driver"; command = "C:\Windows\System32\cmd.exe"; args = @("/k", "C:\tools\bin\cctabs.cmd restart-tabby --yes > C:\Users\dev\rt.log 2>&1") } | ConvertTo-Json
Invoke-WebRequest -UseBasicParsing -Headers $auth -Method Post -ContentType "application/json" -Body $body http://127.0.0.1:3300/api/tabs/new | Out-Null
"driver tab opened at " + (Get-Date -Format HH:mm:ss)
