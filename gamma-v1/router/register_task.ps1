# register_task.ps1 — register/unregister the GemmaAutoLearn scheduled task.
#
# Registers a Windows Task Scheduler job that runs auto_learn.py hourly.
# auto_learn.py itself enforces idle/process/LM-Studio gates, so scheduling
# can be frequent without risk of interrupting user activity.
#
# Usage:
#   .\register_task.ps1                 # install / update
#   .\register_task.ps1 -Unregister     # remove
#   .\register_task.ps1 -RunOnce        # install, then trigger immediately
#
# Requires: run from an elevated PowerShell (Administrator).

param(
    [switch]$Unregister,
    [switch]$RunOnce,
    [string]$TaskName = "GemmaAutoLearn",
    [int]$IntervalMinutes = 60
)

$ErrorActionPreference = "Stop"

$routerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$autoLearn = Join-Path $routerDir "auto_learn.py"

if (-not (Test-Path $autoLearn)) {
    Write-Error "Not found: $autoLearn"
    exit 1
}

if ($Unregister) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed task '$TaskName'."
    } else {
        Write-Host "Task '$TaskName' not found — nothing to remove."
    }
    exit 0
}

# Resolve Python. Prefer 'py -3' launcher; fall back to 'python'.
$pythonCmd = $null
foreach ($candidate in @("py", "python")) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd) { $pythonCmd = $cmd.Source; break }
}
if (-not $pythonCmd) {
    Write-Error "No Python found on PATH. Install Python 3 or add it to PATH."
    exit 1
}
$pythonArg = if ($pythonCmd -match "py.exe$") { @("-3", "`"$autoLearn`"") } else { @("`"$autoLearn`"") }
$argString = $pythonArg -join " "

$action = New-ScheduledTaskAction -Execute $pythonCmd -Argument $argString -WorkingDirectory $routerDir

# Repeat every N minutes for 1 day, starting 5 minutes from now.
$start = (Get-Date).AddMinutes(5)
$trigger = New-ScheduledTaskTrigger -Once -At $start `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 365)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName `
    -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description "Runs Gemma auto-learn hourly; idle/process gates inside the script decide whether to actually distill." `
    -Force | Out-Null

Write-Host "Registered task '$TaskName' — runs every $IntervalMinutes min starting $start."
Write-Host "  Python:   $pythonCmd $argString"
Write-Host "  Audit log: $(Join-Path $routerDir 'auto_learn.log')"

if ($RunOnce) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Triggered task '$TaskName' immediately. Check audit log shortly."
}
