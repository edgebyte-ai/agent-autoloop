param([string]$HomeDirectory, [string]$Node, [string]$JobName)
$ErrorActionPreference = 'Stop'
& "$PSScriptRoot\..\worker\windows.ps1" -Action own -Breakaway -JobName $JobName -RunFile (Join-Path $HomeDirectory 'service-job')
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$words = @($wscript, '//B', '//Nologo', '//E:JScript', (Join-Path $PSScriptRoot 'background.js'), $Node,
    '--disable-warning=ExperimentalWarning', (Join-Path $PSScriptRoot 'background.ts'), $HomeDirectory)
# These are fixed switches and Windows paths, whose only quoting escape is a trailing backslash.
$command = ($words | ForEach-Object { '"' + ($_ -replace '(\\+)$', '$1$1') + '"' }) -join ' '
exit ([TurnJob]::Run($wscript, $command, $PSScriptRoot))
