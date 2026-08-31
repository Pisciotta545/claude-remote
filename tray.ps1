# Ícono de bandeja para Claude Remote: arranca el servidor oculto y permite
# reiniciarlo o detenerlo desde el menú. Además lo supervisa: si se cae mientras
# debía estar corriendo, lo relanza (equivale a run-server.cmd, pero con control).
# Lanzalo oculto con tray.vbs (usa powershell -STA -WindowStyle Hidden).

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = if ($env:PORT) { $env:PORT } else { 3000 }
# Ruta de Node: la del PATH o la instalación por defecto.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }

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
    $psi.Arguments = "server.js"
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
    # Barre cualquier node server.js huérfano (arranques previos).
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*server.js*' } |
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

$miOpen    = $menu.Items.Add("Abrir en el navegador")
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

$miOpen.Add_Click({ Start-Process "http://localhost:$port" })
$miToggle.Add_Click({ if (Test-Running) { Stop-Server } else { Start-Server } })
$miRestart.Add_Click({ Restart-Server })
$miExit.Add_Click({
    Stop-Server
    $notify.Visible = $false
    $notify.Dispose()
    [System.Windows.Forms.Application]::Exit()
})
$notify.Add_MouseDoubleClick({ Start-Process "http://localhost:$port" })

$notify.ContextMenuStrip = $menu
$notify.Visible = $true

# Supervisor: si se cayó mientras debía correr, lo relanza.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({
    if ($script:wantRunning -and -not (Test-Running)) { Start-Server }
    Update-Ui
})
$timer.Start()

Start-Server
[System.Windows.Forms.Application]::Run()
