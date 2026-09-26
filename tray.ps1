# Ícono de bandeja para Claude Remote: arranca el servidor oculto y permite
# reiniciarlo o detenerlo desde el menú. Además lo supervisa: si se cae mientras
# debía estar corriendo, lo relanza (equivale a run-server.cmd, pero con control).
# Lanzalo oculto con tray.vbs (usa powershell -STA -WindowStyle Hidden).

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = if ($env:PORT) { $env:PORT } else { 3000 }
# Ruta de Node: la que trae el instalador (node\node.exe), la del PATH o la
# instalación por defecto.
$node = Join-Path $here "node\node.exe"
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }
$serverJs = Join-Path $here "server.js"
$tsStatus = if ($env:TAILNET_STATUS) { $env:TAILNET_STATUS } else { "127.0.0.1:3099" }
$claudeSetupUrl = "https://docs.anthropic.com/en/docs/claude-code/setup"

$script:proc = $null
$script:wantRunning = $true

# --- Ícono: un punto verde (corriendo) o gris (detenido) --------------------
function New-DotIcon($color) {
    $bmp = New-Object System.Drawing.Bitmap 16, 16
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)
    $brush = New-Object System.Drawing.SolidBrush $color
    $g.FillEllipse($brush, 2, 2, 12, 12)
    $g.Dispose()
    return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$iconOn  = New-DotIcon ([System.Drawing.Color]::FromArgb(16, 185, 129)) # verde
$iconOff = New-DotIcon ([System.Drawing.Color]::FromArgb(120, 120, 120)) # gris

# --- Control del servidor ---------------------------------------------------
function Test-Running {
    return ($script:proc -and -not $script:proc.HasExited)
}

function Start-Server {
    if (Test-Running) { return }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $node
    $psi.Arguments = "`"$serverJs`""
    $psi.WorkingDirectory = $here
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WindowStyle = 'Hidden'
    $script:proc = [System.Diagnostics.Process]::Start($psi)
    $script:wantRunning = $true
    Update-Ui
}

function Stop-Server {
    $script:wantRunning = $false
    if (Test-Running) { try { $script:proc.Kill() } catch {} }
    # Barre servidores huérfanos de ESTA carpeta (ruta completa) o arranques
    # viejos "node server.js" con el mismo Node; no toca otros proyectos de Node.
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like "*$serverJs*" -or
            ($_.ExecutablePath -eq $node -and $_.CommandLine -match '\s"?server\.js"?\s*$') } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    $script:proc = $null
    Update-Ui
}

function Restart-Server {
    Stop-Server
    Start-Sleep -Milliseconds 500
    Start-Server
}

# --- Menú e ícono -----------------------------------------------------------
$notify = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miPair    = $menu.Items.Add("Vincular celular…")
$miAddr    = $menu.Items.Add("Dirección para la app")
$miTsLogin = $menu.Items.Add("Iniciar sesión en Tailscale…")
$miClaude  = $menu.Items.Add("⚠ Falta Claude Code: instalarlo…")
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$miToggle  = $menu.Items.Add("Detener servidor")
$miRestart = $menu.Items.Add("Reiniciar servidor")
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$miExit    = $menu.Items.Add("Salir")

function Update-Ui {
    $running = Test-Running
    $notify.Icon = if ($running) { $iconOn } else { $iconOff }
    $notify.Text = if ($running) { "Claude Remote · corriendo (:$port)" } else { "Claude Remote · detenido" }
    $miToggle.Text = if ($running) { "Detener servidor" } else { "Arrancar servidor" }
    $miRestart.Enabled = $running
}

# Vinculación: genera un código de 6 dígitos (pair.js → pairing.json) que la app
# pide una vez. Sin vincular, el servidor rechaza todo (también los navegadores).
function Show-PairingCode {
    $code = & $node (Join-Path $here "pair.js") --quiet 2>$null | Select-Object -Last 1
    if (-not $code) {
        [System.Windows.Forms.MessageBox]::Show("No se pudo generar el código.", "Claude Remote") | Out-Null
        return
    }
    $msg = "Código: $($code.Substring(0, 3)) $($code.Substring(3))`n`nIngresalo en la app del celular.`nVale 5 minutos y sirve una sola vez."
    [System.Windows.Forms.MessageBox]::Show($msg, "Claude Remote · Vincular celular") | Out-Null
}

# --- Tailscale y Claude Code: avisos para una PC recién instalada ------------
# El login de Tailscale y la dirección para la app salen del estado del nodo
# integrado (claude-remote-ts, en $tsStatus); sin consola visible, el tray es
# el único lugar donde verlos.
$script:tsAuthUrl = ""
$script:tsNotified = ""
$script:tsAddr = ""
$script:claudeOk = [bool](Get-Command claude -ErrorAction SilentlyContinue) -or
    (Test-Path (Join-Path $env:USERPROFILE ".local\bin\claude.exe"))

function Update-Tailnet {
    try { $st = Invoke-RestMethod "http://$tsStatus/status" -TimeoutSec 1 } catch { $st = $null }
    $script:tsAuthUrl = if ($st -and $st.state -eq "NeedsLogin") { $st.authURL } else { "" }
    $script:tsAddr = if ($st -and $st.state -eq "Running" -and $st.ip) { "$($st.ip):$port" } else { "" }
    $miTsLogin.Visible = [bool]$script:tsAuthUrl
    $miAddr.Visible = [bool]$script:tsAddr
    if ($script:tsAddr) { $miAddr.Text = "Dirección para la app: $($script:tsAddr) (copiar)" }
    if ($script:tsAuthUrl -and $script:tsAuthUrl -ne $script:tsNotified) {
        $script:tsNotified = $script:tsAuthUrl
        $notify.ShowBalloonTip(10000, "Claude Remote", "Iniciá sesión en Tailscale para usar la app desde el celular (clic acá).", "Info")
    }
}

$miTsLogin.Add_Click({ if ($script:tsAuthUrl) { Start-Process $script:tsAuthUrl } })
$miAddr.Add_Click({ if ($script:tsAddr) { [System.Windows.Forms.Clipboard]::SetText($script:tsAddr) } })
$miClaude.Add_Click({ Start-Process $claudeSetupUrl })
$notify.Add_BalloonTipClicked({
    if ($script:tsAuthUrl) { Start-Process $script:tsAuthUrl }
    elseif (-not $script:claudeOk) { Start-Process $claudeSetupUrl }
})
$miTsLogin.Visible = $false
$miAddr.Visible = $false
$miClaude.Visible = -not $script:claudeOk

$miPair.Add_Click({ Show-PairingCode })
$miToggle.Add_Click({ if (Test-Running) { Stop-Server } else { Start-Server } })
$miRestart.Add_Click({ Restart-Server })
$miExit.Add_Click({
    Stop-Server
    $notify.Visible = $false
    $notify.Dispose()
    [System.Windows.Forms.Application]::Exit()
})
$notify.Add_MouseDoubleClick({ Show-PairingCode })

$notify.ContextMenuStrip = $menu
$notify.Visible = $true

# Supervisor: si se cayó mientras debía correr, lo relanza. Tailscale se
# consulta cada 5 ticks (15 s).
$script:tick = 0
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({
    if ($script:wantRunning -and -not (Test-Running)) { Start-Server }
    Update-Ui
    if ($script:tick++ % 5 -eq 1) { Update-Tailnet }
})
$timer.Start()

Start-Server
if (-not $script:claudeOk) {
    $notify.ShowBalloonTip(10000, "Claude Remote", "No se encontró Claude Code en esta PC: instalalo e iniciá sesión (clic acá).", "Warning")
}
[System.Windows.Forms.Application]::Run()
