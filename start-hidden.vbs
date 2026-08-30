' Lanza el servidor Claude Remote sin ventana visible (arranque oculto).
' Copiado a la carpeta de Inicio del usuario para arrancar al iniciar sesion.
' Ejecuta el supervisor run-server.cmd, que relanza Node si el proceso muere
' (crash o error de red fatal), de modo que nunca haga falta reiniciar la PC.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Desktop\CLI"
sh.Run """C:\Desktop\CLI\run-server.cmd""", 0, False
