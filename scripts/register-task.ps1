<#
.SYNOPSIS
  Register (or remove) a Windows Scheduled Task that runs `spotifify sync` daily.

.EXAMPLE
  .\scripts\register-task.ps1 -Time 03:00
  .\scripts\register-task.ps1 -Exe D:\tools\spotifify.exe -Time 03:00
  .\scripts\register-task.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$TaskName = "Spotifify Sync",
  [string]$Time = "03:00",
  # Path to a compiled spotifify.exe. When omitted, runs `bun run src/cli.ts` from the repo root.
  [string]$Exe = "",
  [string]$LogDir = (Join-Path $env:USERPROFILE ".spotifify\logs"),
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "removed task '$TaskName'"
  exit 0
}

$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$log = Join-Path $LogDir "sync-$(Get-Date -Format yyyyMMdd).log"

if ($Exe) {
  $action = New-ScheduledTaskAction -Execute $Exe -Argument "sync --log-file `"$log`"" -WorkingDirectory $repo
} else {
  $bun = (Get-Command bun).Source
  $action = New-ScheduledTaskAction -Execute $bun -Argument "run src/cli.ts sync --log-file `"$log`"" -WorkingDirectory $repo
}

$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 6)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "registered task '$TaskName' daily at $Time (log: $log)"
