# Compila el Tailscale integrado (tsnet) a android/app/libs/tailnet.aar.
# Requiere Go (def. %USERPROFILE%\sdk\go), gomobile/gobind en %USERPROFILE%\go\bin
# (go install golang.org/x/mobile/cmd/gomobile@latest; gomobile init) y el NDK de Android.
$ErrorActionPreference = 'Stop'
$env:Path = "$env:USERPROFILE\sdk\go\bin;$env:USERPROFILE\go\bin;$env:Path"
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = 'C:\Android' }
if (-not $env:ANDROID_NDK_HOME) {
    $env:ANDROID_NDK_HOME = (Get-ChildItem "$env:ANDROID_HOME\ndk" -Directory | Sort-Object Name | Select-Object -Last 1).FullName
}
Push-Location $PSScriptRoot
try {
    New-Item -ItemType Directory -Force ..\app\libs | Out-Null
    # Argumentos entre comillas: PowerShell parte "-javapkg=com.claude..." en el punto.
    gomobile bind '-target=android/arm64' '-androidapi' '24' '-ldflags=-s -w' '-javapkg=com.claude.remote.go' '-o' '..\app\libs\tailnet.aar' '.'
    if ($LASTEXITCODE) { throw "gomobile bind falló ($LASTEXITCODE)" }
    Write-Host "OK -> android/app/libs/tailnet.aar"
} finally {
    Pop-Location
}
