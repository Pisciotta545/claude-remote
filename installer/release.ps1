# Arma (y con -Publish publica) una release de GitHub: APK de producción +
# app-version.json (autoupdate de las apps) + instalador del servidor +
# SHA256SUMS.txt, con las huellas en las notas para verificar los archivos.
# Antes: cd android; ./gradlew.bat assembleRelease  y  powershell installer/build.ps1
param([switch]$Publish)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$gradle = Get-Content (Join-Path $root 'android/app/build.gradle') -Raw
$vCode = [int]([regex]::Match($gradle, 'versionCode\s+(\d+)').Groups[1].Value)
$vName = [regex]::Match($gradle, 'versionName\s+"([^"]+)"').Groups[1].Value

$apk = Join-Path $root "android/app/build/outputs/apk/release/ClaudeRemote-v$vName.apk"
$exe = Join-Path $PSScriptRoot "Output/$($pkg.productName)-v$($pkg.version).exe"
foreach ($f in $apk, $exe) { if (-not (Test-Path $f)) { throw "Falta $f" } }

$out = Join-Path $PSScriptRoot 'release'
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item $apk, $exe $out
[System.IO.File]::WriteAllText((Join-Path $out 'app-version.json'), (@{ versionCode = $vCode; versionName = $vName } | ConvertTo-Json))

# SHA-256 con .NET (Get-FileHash no siempre está disponible en PowerShell 5.1).
function Get-Sha256($path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $fs = [System.IO.File]::OpenRead($path)
    try { return (($sha.ComputeHash($fs) | ForEach-Object { $_.ToString('x2') }) -join '') }
    finally { $fs.Dispose(); $sha.Dispose() }
}
$files = Get-ChildItem $out | Sort-Object Name
$sums = $files | ForEach-Object { "$(Get-Sha256 $_.FullName)  $($_.Name)" }
[System.IO.File]::WriteAllText((Join-Path $out 'SHA256SUMS.txt'), (($sums -join "`n") + "`n"))

$apkName = Split-Path $apk -Leaf
$exeName = Split-Path $exe -Leaf
$notes = @"
Controlá Claude Code de tu PC desde el celular.

## Descargas
| Archivo | Para qué |
|---|---|
| ``$exeName`` | Instalador del **servidor** para Windows (x64). No pide admin; trae Node y Tailscale integrado. |
| ``$apkName`` | **App** para Android. |
| ``app-version.json`` | Lo usan los servidores para actualizar la app solos. |

## Instalación
1. En la PC, instalá [Claude Code](https://docs.anthropic.com/en/docs/claude-code/setup), iniciá sesión y abrí con ``claude`` las carpetas que quieras usar desde el celular.
2. Ejecutá ``$exeName`` (si Windows avisa, *Más información → Ejecutar de todas formas*). Queda un punto verde en la bandeja.
3. Clic derecho en el punto → **Iniciar sesión en Tailscale…**.
4. Instalá el APK; como dirección, la de **Dirección para la app** (menú de la bandeja), con **Tailscale integrado** activado.
5. Menú de la bandeja → **Vincular celular…** y escribí el código en la app.

## Verificar los archivos
Antes de instalar, compará la huella SHA-256 (PowerShell: ``Get-FileHash .\archivo``, o ``certutil -hashfile archivo SHA256``) con esta tabla. Si no coincide, no lo instales.

| SHA-256 | Archivo |
|---|---|
$(($files | ForEach-Object { "| ``$(Get-Sha256 $_.FullName)`` | $($_.Name) |" }) -join "`n")

Certificado de firma del APK (SHA-256): ``52:EA:48:49:97:63:1B:04:A8:DA:E2:8A:9B:24:CE:99:90:18:43:F5:57:00:E7:C3:D6:47:92:21:F2:FD:99:2F``
"@
$notesPath = Join-Path $out 'notes.md'
[System.IO.File]::WriteAllText($notesPath, $notes)

$tag = "v$vName"
$assets = (Get-ChildItem $out | Where-Object Name -ne 'notes.md').FullName
Write-Host "Release $tag lista en $out :"
$assets | ForEach-Object { Write-Host "  $(Split-Path $_ -Leaf)" }
if (-not $Publish) { Write-Host "Para publicarla: powershell installer/release.ps1 -Publish"; return }
gh release create $tag @assets --title "Claude Remote v$vName · servidor v$($pkg.version)" --notes-file $notesPath
if ($LASTEXITCODE) { throw "gh release create falló ($LASTEXITCODE)" }
