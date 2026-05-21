$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $ProjectDir
try {
    python -m PyInstaller `
        --noconfirm `
        --onefile `
        --windowed `
        --name AMC_Gateway_GUI `
        --paths src `
        --hidden-import serial `
        --hidden-import serial.tools.list_ports `
        src\amc_gateway\gui_launcher.py

    $config = Get-Content -Raw -Encoding UTF8 "meter_config.example.json" | ConvertFrom-Json
    $config.pointTablePath = "point_table.json"
    $config | ConvertTo-Json -Depth 20 | Set-Content -Encoding UTF8 "dist\meter_config.json"

    $pointTable = Get-ChildItem -LiteralPath ".." -Filter "*-v1.json" | Select-Object -First 1
    if ($null -eq $pointTable) {
        throw "Point table *-v1.json not found in parent directory."
    }
    Copy-Item -LiteralPath $pointTable.FullName -Destination "dist\point_table.json"

    Write-Host "Built dist\AMC_Gateway_GUI.exe"
    Write-Host "Packaged editable config: dist\meter_config.json"
    Write-Host "Packaged point table: dist\point_table.json"
}
finally {
    Pop-Location
}
