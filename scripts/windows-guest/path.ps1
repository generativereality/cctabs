$d = "$env:USERPROFILE\.local\bin"
$p = [Environment]::GetEnvironmentVariable("Path", "User")
if ($p -notlike "*$d*") { [Environment]::SetEnvironmentVariable("Path", "$d;$p", "User") }
"user PATH starts: " + ([Environment]::GetEnvironmentVariable("Path", "User")).Substring(0, 60)
