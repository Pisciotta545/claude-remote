; Instalador del servidor de Claude Remote (Inno Setup 6).
; No compilar a mano: installer/build.ps1 arma la carpeta "stage" y pasa
; AppName/AppVersion (de package.json) y Stage.
#ifndef AppName
  #error Compilar con installer/build.ps1
#endif

[Setup]
AppId={{6F1C2B7E-3D4A-4E8B-9C21-7A5D0E9F4B13}
AppName=Claude Remote (servidor)
AppVersion={#AppVersion}
AppVerName=Claude Remote (servidor) {#AppVersion}
; Por usuario y sin admin: el servidor escribe su estado (clave de la app,
; login de Tailscale) en su propia carpeta.
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\ClaudeRemote
DisableProgramGroupPage=yes
OutputBaseFilename={#AppName}-v{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
CloseApplications=no
UninstallDisplayName=Claude Remote (servidor)

[Languages]
Name: "es"; MessagesFile: "compiler:Languages\Spanish.isl"

[Messages]
FinishedLabel=Claude Remote quedó instalado y corre en la bandeja (punto verde, abajo a la derecha).%n%n1. Clic derecho en el punto → "Iniciar sesión en Tailscale…" y entrá con tu cuenta.%n2. Instalá la app en el celular y usá la dirección que muestra el menú.%n3. Menú → "Vincular celular…" y escribí el código en la app.

[Tasks]
Name: "autostart"; Description: "Arrancar con Windows"

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{userprograms}\Claude Remote"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\tray.vbs"""; WorkingDir: "{app}"; Comment: "Servidor de Claude Remote (bandeja)"
Name: "{userstartup}\Claude Remote"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\tray.vbs"""; WorkingDir: "{app}"; Tasks: autostart

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\tray.vbs"""; WorkingDir: "{app}"; Description: "Iniciar Claude Remote ahora"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
; Estado local (clave de la app, login de Tailscale, tokens push).
Type: filesandordirs; Name: "{app}"

[Code]
// Cierra el tray, el servidor y Tailscale de ESTA instalación (para actualizar
// o desinstalar sin archivos bloqueados). Filtra por ruta: no toca otros Node.
procedure StopRunning();
var
  Cmd: String;
  Code: Integer;
begin
  Cmd := '-NoProfile -ExecutionPolicy Bypass -Command "$d = ''' + ExpandConstant('{app}') + '''; ' +
    'Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ' +
    '$_.Name -in @(''node.exe'',''powershell.exe'',''claude-remote-ts.exe'') -and ' +
    '(($_.ExecutablePath -like \"$d\*\") -or ($_.CommandLine -like \"*$d\*\")) } | ' +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"';
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Cmd, '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

function ClaudeInstalled(): Boolean;
var
  Code: Integer;
begin
  Result := FileExists(ExpandConstant('{%USERPROFILE}\.local\bin\claude.exe')) or
    (Exec(ExpandConstant('{cmd}'), '/c where claude', '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0));
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if not ClaudeInstalled() then
    Result := MsgBox('No se encontró Claude Code en esta PC.' + #13#10#13#10 +
      'El servidor lo necesita: instalalo (docs.anthropic.com/en/docs/claude-code/setup), ' +
      'abrilo una vez para iniciar sesión y abrí con él las carpetas que quieras usar desde el celular.' + #13#10#13#10 +
      '¿Instalar Claude Remote igual?', mbConfirmation, MB_YESNO) = IDYES;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopRunning();
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then StopRunning();
end;
