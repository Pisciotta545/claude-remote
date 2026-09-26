# Arma el instalador del servidor: installer\Output\<productName>-v<version>.exe
# (nombre y versión salen de package.json). Incluye Node portable (el de esta
# PC), las dependencias, el Tailscale de la PC y el APK del autoactualizador.
# Nunca incluye secretos ni estado local (lista blanca de archivos).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$stage = Join-Path $PSScriptRoot 'stage'

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null

foreach ($f in 'server.js', 'security.js', 'pair.js', 'devices.js', 'push.js', 'package.json', 'package-lock.json',
               'tray.ps1', 'tray.vbs') {
    Copy-Item (Join-Path $root $f) $stage
}
Copy-Item -Recurse (Join-Path $root 'public') (Join-Path $stage 'public')

# Tailscale integrado de la PC (sin él, la app solo llega por red local).
$ts = Join-Path $root 'claude-remote-ts.exe'
if (-not (Test-Path $ts)) { & (Join-Path $root 'tailnet-host\build.ps1') }
Copy-Item $ts $stage

# Clave limitada (solo enviar push) para que las notificaciones anden en otras
# PC. NUNCA la completa (firebase-service-account.json).
$sender = Join-Path $root 'push-sender.json'
if (Test-Path $sender) { Copy-Item $sender $stage } else { Write-Warning 'Sin push-sender.json: en otras PC no habrá notificaciones.' }

# APK de PRODUCCIÓN (firmado, no depurable) de la versión de app/build.gradle,
# con su app-version.json: lo que instala y actualiza la app en esa PC.
$gradle = Get-Content (Join-Path $root 'android/app/build.gradle') -Raw
$vCode = [int]([regex]::Match($gradle, 'versionCode\s+(\d+)').Groups[1].Value)
$vName = [regex]::Match($gradle, 'versionName\s+"([^"]+)"').Groups[1].Value
$apk = Join-Path $root "android/app/build/outputs/apk/release/ClaudeRemote-v$vName.apk"
if (-not (Test-Path $apk)) { throw "Falta $apk (cd android; ./gradlew.bat assembleRelease)" }
Copy-Item $apk (Join-Path $stage 'claude-remote.apk')
[System.IO.File]::WriteAllText((Join-Path $stage 'app-version.json'), (@{ versionCode = $vCode; versionName = $vName } | ConvertTo-Json))

# Dependencias de producción (node-pty trae binarios precompilados: no compila).
Push-Location $stage
try {
    npm ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE) { throw "npm ci falló ($LASTEXITCODE)" }
} finally { Pop-Location }
# Solo hacen falta los binarios de Windows x64 (sin símbolos .pdb): ~58 MB menos.
$pty = Join-Path $stage 'node_modules\node-pty'
Get-ChildItem (Join-Path $pty 'prebuilds') -Directory | Where-Object Name -ne 'win32-x64' | Remove-Item -Recurse -Force
Get-ChildItem $pty -Recurse -Filter *.pdb | Remove-Item -Force

# Node portable: el mismo con el que se probó node-pty acá.
New-Item -ItemType Directory -Force (Join-Path $stage 'node') | Out-Null
Copy-Item (Get-Command node).Source (Join-Path $stage 'node\node.exe')

$iscc = @(
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw 'Falta Inno Setup 6 (winget install JRSoftware.InnoSetup)' }

& $iscc /Q "/DAppName=$($pkg.productName)" "/DAppVersion=$($pkg.version)" "/DStage=$stage" `
    "/O$(Join-Path $PSScriptRoot 'Output')" (Join-Path $PSScriptRoot 'ClaudeRemoteServer.iss')
if ($LASTEXITCODE) { throw "ISCC falló ($LASTEXITCODE)" }
Get-Item (Join-Path $PSScriptRoot "Output\$($pkg.productName)-v$($pkg.version).exe")
