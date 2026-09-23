# Compila claude-remote-ts.exe (Tailscale integrado para la PC) en la raíz del repo.
# Requiere Go (def. %USERPROFILE%\sdk\go).
$ErrorActionPreference = 'Stop'
$env:Path = "$env:USERPROFILE\sdk\go\bin;$env:Path"
Push-Location $PSScriptRoot
try {
    go build '-ldflags=-s -w' -o '..\claude-remote-ts.exe' .
    if ($LASTEXITCODE) { throw "go build falló ($LASTEXITCODE)" }
    Write-Host "OK -> claude-remote-ts.exe"
} finally {
    Pop-Location
}
