@echo off
rem Supervisor: mantiene vivo el servidor. Si Node sale (crash, error de red
rem fatal, etc.) lo relanza a los 2 s, sin necesidad de reiniciar la PC.
cd /d "C:\Desktop\CLI"
:loop
"C:\Program Files\nodejs\node.exe" server.js
timeout /t 2 /nobreak >nul
goto loop
