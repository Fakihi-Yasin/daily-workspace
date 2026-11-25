# Daily Workspace — install the PC Work Time agent on Windows 10/11 (current user, no admin).
#   $env:DW_CODE='<CODE>'; irm https://<your-dashboard>/pc-agent/install-windows.ps1 | iex
# Needs Python 3.9+ (python.org or: winget install Python.Python.3.12).
$ErrorActionPreference = 'Stop'
$code = $env:DW_CODE
if (-not $code) { $code = Read-Host 'Paste the code from Settings -> PC Work Time' }
$py = (Get-Command py -ErrorAction SilentlyContinue)
if ($py) { $pyArgs = @('-3') } else { $py = (Get-Command python -ErrorAction SilentlyContinue); $pyArgs = @() }
if (-not $py) { throw 'Python 3 is missing. Install it with: winget install Python.Python.3.12  (then open a new PowerShell and try again).' }
$pad = '=' * ((4 - $code.Length % 4) % 4)
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($code -replace '-', '+' -replace '_', '/') + $pad)) | ConvertFrom-Json
if (-not ($json.o -like 'https://*')) { throw 'That code is not valid. Copy it again from Settings -> PC Work Time.' }
$dir = Join-Path $env:LOCALAPPDATA 'DailyWorkspacePCTime'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$agent = Join-Path $dir 'dw-pc-time.py'
Invoke-WebRequest -UseBasicParsing -Uri "$($json.o)/pc-agent/dw-pc-time.py" -OutFile $agent
& $py.Source @pyArgs $agent pair $code
& $py.Source @pyArgs $agent autostart on      # HKCU Run key: starts at login (pythonw, no window)
$exe = & $py.Source @pyArgs -c "import sys,os; p=os.path.join(os.path.dirname(sys.executable),'pythonw.exe'); print(p if os.path.exists(p) else sys.executable)"
Start-Process -FilePath $exe -ArgumentList "`"$agent`" run" -WindowStyle Hidden
Write-Host "Done. PC Work Time starts at login. Commands: py `"$agent`" status | pause | resume | open"
