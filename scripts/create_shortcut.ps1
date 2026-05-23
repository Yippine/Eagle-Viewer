# Create Eagle Viewer desktop shortcut.
# Run once after cloning / moving the project folder.
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ico  = $root + '\viewer\icon.ico'
$vbs  = $root + '\start.vbs'
$dest = [Environment]::GetFolderPath('Desktop') + '\Eagle Viewer.lnk'

$ws  = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($dest)
$lnk.TargetPath       = "$env:SystemRoot\System32\wscript.exe"
$lnk.Arguments        = "`"$vbs`""
$lnk.WorkingDirectory = $root
$lnk.IconLocation     = "$ico,0"
$lnk.Description      = 'Eagle Viewer'
$lnk.Save()

$check = $ws.CreateShortcut($dest)
Write-Host "Shortcut created at: $dest"
Write-Host "IconLocation: $($check.IconLocation)"
Write-Host "TargetPath:   $($check.TargetPath)"
