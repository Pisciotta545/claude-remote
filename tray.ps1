# Ícono de bandeja para Claude Remote: arranca el servidor oculto y permite
# reiniciarlo o detenerlo desde el menú. Además lo supervisa: si se cae mientras
# debía estar corriendo, lo relanza (equivale a run-server.cmd, pero con control).
# Lanzalo oculto con tray.vbs (usa powershell -STA -WindowStyle Hidden).

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
# Puerto: lo elige el servidor (PORT > config.json > 3000 en un clon de git >
# uno libre al azar guardado en config.json); el tray lo lee de ahí.
$configPath = Join-Path $here "config.json"
function Get-Port {
    if ($env:PORT) { return [int]$env:PORT }
    try { $p = (Get-Content $configPath -Raw | ConvertFrom-Json).port; if ($p) { return [int]$p } } catch {}
    return 3000
}
$port = Get-Port
# Ruta de Node: la que trae el instalador (node\node.exe), la del PATH o la
# instalación por defecto.
$node = Join-Path $here "node\node.exe"
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }
$serverJs = Join-Path $here "server.js"
function Get-TsStatus { if ($env:TAILNET_STATUS) { $env:TAILNET_STATUS } else { "127.0.0.1:$($port + 99)" } }
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
$miDevices = $menu.Items.Add("Celulares vinculados…")
$miAddr    = $menu.Items.Add("Dirección para la app")
$miTsLogin = $menu.Items.Add("Iniciar sesión en Tailscale…")
$miClaude  = $menu.Items.Add("⚠ Falta Claude Code: instalarlo…")
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$miToggle  = $menu.Items.Add("Detener servidor")
$miRestart = $menu.Items.Add("Reiniciar servidor")
$miPort    = $menu.Items.Add("Cambiar puerto…")
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
    try { $st = Invoke-RestMethod "http://$(Get-TsStatus)/status" -TimeoutSec 1 } catch { $st = $null }
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

# Cambiar puerto: elige uno libre al azar (20000–29999, y +99 para el estado de
# Tailscale), lo guarda en config.json y reinicia. La app necesita la dirección nueva.
function Test-PortFree($p) {
    try { $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $p); $l.Start(); $l.Stop(); return $true }
    catch { return $false }
}
function Set-NewPort {
    if ($env:PORT) {
        [System.Windows.Forms.MessageBox]::Show("El puerto está fijado por la variable PORT ($env:PORT).", "Claude Remote") | Out-Null
        return
    }
    $ok = [System.Windows.Forms.MessageBox]::Show(
        "Se elige un puerto libre nuevo y se reinicia el servidor.`n`nDespués, en la app del celular, poné la dirección nueva (menú → Dirección para la app).",
        "Claude Remote · Cambiar puerto", "OKCancel")
    if ($ok -ne "OK") { return }
    Stop-Server
    $new = 0
    for ($i = 0; $i -lt 50 -and -not $new; $i++) {
        $p = Get-Random -Minimum 20000 -Maximum 30000
        if ((Test-PortFree $p) -and (Test-PortFree ($p + 99))) { $new = $p }
    }
    if (-not $new) { [System.Windows.Forms.MessageBox]::Show("No encontré un puerto libre.", "Claude Remote") | Out-Null; Start-Server; return }
    $cfg = @{}
    try { (Get-Content $configPath -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $cfg[$_.Name] = $_.Value } } catch {}
    $cfg.port = $new
    # Sin BOM: Node no parsea JSON con BOM.
    [System.IO.File]::WriteAllText($configPath, ($cfg | ConvertTo-Json))
    $script:port = $new
    $script:portWarned = $false
    Start-Server
}
$miPort.Add_Click({ Set-NewPort })

# Celulares vinculados (devices.js): cada uno tiene su clave; desvincular uno lo
# echa al instante (el servidor corta su conexión) sin tocar a los demás.
function Show-Devices {
    $json = & $node (Join-Path $here "devices.js") --json 2>$null | Out-String
    try { $script:devList = @($json | ConvertFrom-Json) } catch { $script:devList = @() }
    $f = New-Object System.Windows.Forms.Form
    $f.Text = "Claude Remote · Celulares vinculados"
    $f.Size = New-Object System.Drawing.Size(520, 330)
    $f.StartPosition = "CenterScreen"
    $f.TopMost = $true
    $f.FormBorderStyle = "FixedDialog"
    $f.MaximizeBox = $false
    $info = New-Object System.Windows.Forms.Label
    $info.Text = "Si perdés un celular o ya no lo usás, desvinculalo: queda afuera al instante."
    $info.SetBounds(12, 10, 480, 20)
    $lb = New-Object System.Windows.Forms.ListBox
    $lb.SetBounds(12, 34, 480, 200)
    foreach ($d in $script:devList) {
        $when = if ($d.created) { " · desde $("$($d.created)".Substring(0, 10))" } else { "" }
        [void]$lb.Items.Add("$($d.name)$when")
    }
    if (-not $script:devList.Count) { [void]$lb.Items.Add("(ningún celular vinculado)"); $lb.Enabled = $false }
    $btn = New-Object System.Windows.Forms.Button
    $btn.Text = "Desvincular"
    $btn.SetBounds(12, 244, 120, 30)
    $btn.Add_Click({
        $i = $lb.SelectedIndex
        if ($i -lt 0 -or -not $script:devList.Count) { return }
        $d = $script:devList[$i]
        $ok = [System.Windows.Forms.MessageBox]::Show("¿Desvincular `"$($d.name)`"? Para volver a usarlo habrá que vincularlo de nuevo.", "Claude Remote", "YesNo")
        if ($ok -ne "Yes") { return }
        & $node (Join-Path $here "devices.js") revoke $d.id | Out-Null
        $script:devList = @($script:devList | Where-Object { $_.id -ne $d.id })
        $lb.Items.RemoveAt($i)
    })
    $close = New-Object System.Windows.Forms.Button
    $close.Text = "Cerrar"
    $close.SetBounds(392, 244, 100, 30)
    $close.Add_Click({ $f.Close() })
    $f.Controls.AddRange(@($info, $lb, $btn, $close))
    [void]$f.ShowDialog()
}
$miDevices.Add_Click({ Show-Devices })

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
# Si el servidor salió con 98 (puerto ocupado) no se relanza en bucle: se avisa.
$script:tick = 0
$script:portWarned = $false
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({
    if ($script:wantRunning -and -not (Test-Running)) {
        if ($script:proc -and $script:proc.ExitCode -eq 98) {
            $script:wantRunning = $false
            if (-not $script:portWarned) {
                $script:portWarned = $true
                $notify.ShowBalloonTip(15000, "Claude Remote", "El puerto $port está ocupado por otro programa. Clic derecho → Cambiar puerto…", "Warning")
            }
        } else { Start-Server }
    }
    $script:port = Get-Port
    Update-Ui
    if ($script:tick++ % 5 -eq 1) { Update-Tailnet }
})
$timer.Start()

Start-Server
if (-not $script:claudeOk) {
    $notify.ShowBalloonTip(10000, "Claude Remote", "No se encontró Claude Code en esta PC: instalalo e iniciá sesión (clic acá).", "Warning")
}
[System.Windows.Forms.Application]::Run()
