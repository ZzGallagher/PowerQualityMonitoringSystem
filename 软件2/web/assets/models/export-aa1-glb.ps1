$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")
$source = Join-Path $root "AA1.blend"
$target = Join-Path $PSScriptRoot "AA1.glb"
$localConfig = Join-Path $PSScriptRoot "export-aa1-glb.config.json"
$exportScript = Join-Path $PSScriptRoot "export-aa1-glb.generated.py"

if (-not (Test-Path -LiteralPath $source)) {
  throw "Source model not found: $source"
}

$configuredBlender = $env:BLENDER_EXE_PATH
if (-not $configuredBlender -and (Test-Path -LiteralPath $localConfig)) {
  $config = Get-Content -LiteralPath $localConfig -Raw | ConvertFrom-Json
  $configuredBlender = $config.blenderExePath
}

$blender = if ($configuredBlender -and (Test-Path -LiteralPath $configuredBlender)) { $configuredBlender } else { $null }
if (-not $blender) {
  $blenderCommand = Get-Command blender -ErrorAction SilentlyContinue
  $blender = if ($blenderCommand) { $blenderCommand.Source } else { $null }
}
if (-not $blender) {
  $candidates = @(
    "D:\Program Files\Blender4.0.1(64bit)\blender-4.0.1\blender.exe",
    "C:\Program Files\Blender Foundation\Blender 4.3\blender.exe",
    "C:\Program Files\Blender Foundation\Blender 4.2\blender.exe",
    "C:\Program Files\Blender Foundation\Blender 4.1\blender.exe",
    "C:\Program Files\Blender Foundation\Blender 4.0\blender.exe"
  )
  $blender = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

if (-not $blender) {
  throw "blender.exe was not found. Set BLENDER_EXE_PATH or create export-aa1-glb.config.json with blenderExePath, then retry."
}

$targetForPython = $target.Replace("\", "/")
$python = @"
import bpy

aliases = {
    'aa2-ct1-btn': 'AA1_C1_LAMP',
    'aa2-ct1-handle': 'AA1_C1_HANDLE',
    'aa2-ct2-btn': 'AA1_C2_LAMP',
    'aa2-ct2-handle': 'AA1_C2_HANDLE',
    'aa2-ct3-btn': 'AA1_C3_LAMP',
    'aa2-ct3-handle.': 'AA1_C3_HANDLE',
    'aa2-gdb-scree': 'AA1_C4_LAMP',
    'aa2-gdb-handle.': 'AA1_C4_HANDLE',
}

for source_name, target_name in aliases.items():
    obj = bpy.data.objects.get(source_name)
    if obj:
        obj.name = target_name

for object_name in ['Rectangle204']:
    obj = bpy.data.objects.get(object_name)
    if obj:
        bpy.data.objects.remove(obj, do_unlink=True)

bpy.ops.export_scene.gltf(filepath=r"$targetForPython", export_format='GLB')
"@
if (Test-Path -LiteralPath $target) {
  Remove-Item -LiteralPath $target
}

[System.IO.File]::WriteAllText($exportScript, $python, [System.Text.Encoding]::UTF8)
try {
  $arguments = @("-b", $source, "--python", $exportScript)
  & $blender @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Blender exited with code $LASTEXITCODE"
  }
} finally {
  if (Test-Path -LiteralPath $exportScript) {
    Remove-Item -LiteralPath $exportScript
  }
}

if (-not (Test-Path -LiteralPath $target)) {
  throw "Export failed: $target"
}

Write-Host "Exported $target"
