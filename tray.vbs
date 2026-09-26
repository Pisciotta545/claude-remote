' Lanza el icono de bandeja de Claude Remote sin ventana visible.
' Para el autoarranque, crear un ACCESO DIRECTO a este archivo en shell:startup
' (el instalador lo hace solo): usa la carpeta donde esta este .vbs.
' El tray arranca el servidor y lo supervisa; desde su menu se puede
' reiniciar o detener. Usa -STA porque Windows Forms lo requiere.
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = here
sh.Run "powershell.exe -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\tray.ps1""", 0, False
