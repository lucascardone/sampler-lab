# Builds Sampler Lab (release) and installs it for this user, with shortcuts on the
# Desktop and in the Start menu. Run it again after changing the code to update.
#
#   powershell -ExecutionPolicy Bypass -File scripts\instalar-en-windows.ps1
#
# No admin rights needed: it installs to %LOCALAPPDATA%\Programs\Sampler Lab.

$ErrorActionPreference = "Stop"
$app = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $env:LOCALAPPDATA "Programs\Sampler Lab"
$exe = Join-Path $dest "Sampler Lab.exe"

Write-Host "1/3 Compilando la version final (tarda unos minutos la primera vez)..."
Push-Location $app
try {
    npx tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "La compilacion fallo (codigo $LASTEXITCODE)." }
} finally {
    Pop-Location
}
$built = Join-Path $app "src-tauri\target\release\sampler-lab.exe"
if (-not (Test-Path $built)) { throw "No se encontro $built" }

Write-Host "2/3 Instalando en $dest ..."
# If the installed copy is running (it lives in the tray), close it so it can be replaced.
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force
    Start-Sleep -Milliseconds 500
}
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item $built $exe -Force
Copy-Item (Join-Path $app "src-tauri\icons\icon.ico") (Join-Path $dest "icon.ico") -Force

Write-Host "3/3 Creando accesos directos..."
$shell = New-Object -ComObject WScript.Shell
$places = @(
    [Environment]::GetFolderPath("Desktop"),
    [Environment]::GetFolderPath("Programs")
)
foreach ($dir in $places) {
    $lnk = $shell.CreateShortcut((Join-Path $dir "Sampler Lab.lnk"))
    $lnk.TargetPath = $exe
    $lnk.WorkingDirectory = $dest
    $lnk.IconLocation = "$exe,0"
    $lnk.Description = "Capturar, cortar y combinar samples"
    $lnk.Save()
    Write-Host "   $dir\Sampler Lab.lnk"
}
Write-Host "Listo. Abri Sampler Lab desde el escritorio o el menu Inicio."
