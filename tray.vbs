' Lanza el icono de bandeja de Claude Remote sin ventana visible.
' Copialo a shell:startup para que arranque al iniciar sesion.
' El tray arranca el servidor y lo supervisa; desde su menu se puede
' reiniciar o detener. Usa -STA porque Windows Forms lo requiere.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Desktop\CLI"
sh.Run "powershell.exe -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Desktop\CLI\tray.ps1""", 0, False
