# Claude Remote

PWA para controlar **Claude CLI** desde un celular Android vía navegador, en red local o mediante **Tailscale**. Terminal en tiempo real (`xterm.js` + `node-pty` sobre WebSocket) y panel de consumo de tokens.

## Requisitos

- Node.js ≥ 18
- Claude CLI instalado y autenticado (`claude` en el `PATH`)
- Herramientas de compilación para `node-pty` (Windows: Build Tools de VS; Linux: `build-essential`, `python3`)

## Instalación

```bash
npm install
```

## Ejecución

```bash
npm start        # producción
npm run dev      # recarga automática
```

Servidor por defecto en `http://0.0.0.0:3000`.

### Autoarranque oculto con Windows

Dos archivos trabajan juntos: `start-hidden.vbs` lanza sin ventana (`windowStyle 0`) el supervisor `run-server.cmd`, que ejecuta `node server.js` en bucle y lo relanza a los 2 s si el proceso muere (crash o error de red fatal), sin reiniciar la PC. Para que arranque al iniciar sesión, se copia el `.vbs` a la carpeta de Inicio del usuario (no requiere admin):

```powershell
Copy-Item start-hidden.vbs -Destination ([Environment]::GetFolderPath('Startup')) -Force
```

- **Desactivar:** borrar `start-hidden.vbs` de `shell:startup`.
- **Parar el servidor en marcha:** `Get-Process node | Stop-Process` (o desde el Administrador de tareas).
- Si Node no está en `C:\Program Files\nodejs\node.exe`, editar la ruta dentro de `run-server.cmd`.

### Variables de entorno

| Variable | Defecto | Descripción |
|----------|---------|-------------|
| `PORT` | `3000` | Puerto HTTP/WebSocket |
| `HOST` | `0.0.0.0` | Interfaz de escucha |
| `CLAUDE_CMD` | `claude --dangerously-skip-permissions` | Comando a ejecutar en el PTY (sin prompts de permiso) |
| `SHELL` | `powershell.exe` (Windows) · `bash` (Unix) | Shell que lanza el comando. Los argumentos se eligen según el shell real: PowerShell → `-NoLogo -Command`, cmd → `/c`, POSIX → `-lc` |
| `PROJECTS_DIRS` | carpeta que contiene el repo | Raíces (separadas por `;`) donde buscar proyectos |
| `PROJECTS_DEPTH` | `3` | Profundidad máxima al buscar proyectos anidados dentro de las raíces |
| `CLAUDE_CWD` | home del usuario | Carpeta por defecto si no se elige proyecto |
| `SESSION_IDLE_MS` | `0` (nunca) | Ms que sobrevive la sesión sin clientes conectados. `0` = sigue en segundo plano hasta pulsar "Cerrar" |
| `SESSION_BUFFER_BYTES` | `200000` | Tope del buffer de pantalla que se reenvía al reconectar |
| `FIREBASE_SA_PATH` | `firebase-service-account.json` (raíz) | Service account de Firebase para enviar push. Si falta, el push queda desactivado |
| `PUSH_TOKENS_PATH` | `push-tokens.json` (raíz) | Archivo donde se guardan los tokens FCM de los dispositivos |
| `APK_PATH` | `claude-remote.apk` (raíz) | Ruta del APK que sirve el autoactualizador |

## Conexión desde Android (Tailscale)

1. Instala Tailscale en el servidor y en el celular; inicia sesión con la misma cuenta.
2. Obtén la IP Tailscale del servidor: `tailscale ip -4` (ej. `100.x.y.z`).
3. En Chrome del celular abre `http://100.x.y.z:3000`.
4. **Menú ⋮ → Agregar a pantalla de inicio** para instalarla como PWA.

> En red local usa la IP LAN del servidor en lugar de la de Tailscale.

## App Android (APK)

Alternativa a la PWA: un APK nativo (`android/`) que envuelve la web en un `WebView`, con ícono propio y pantalla completa. **Sigue necesitando el servidor de la PC corriendo** (es un cliente remoto).

### Compilar

Requiere SDK de Android (`ANDROID_HOME`) + JDK 17.

```bash
cd android
./gradlew.bat assembleDebug   # Windows (usar ./gradlew en Linux/Mac)
```

APK firmado (clave de debug) en `android/app/build/outputs/apk/debug/app-debug.apk`.

### Instalar y usar

1. Pasá el `.apk` al celu (USB, Telegram, Drive) y abrilo, o `adb install app-debug.apk`.
2. Permití "Instalar apps de orígenes desconocidos" si Android lo pide.
3. Abrí **Claude Remote**, ingresá `IP:puerto` (ej. `100.x.y.z:3000`) y tocá **Conectar**.
4. Elegí un **proyecto** de la lista; Claude arranca dentro de esa carpeta. Botón **‹ Proyectos** para volver a elegir.
5. Menú **⋮**: *Cambiar servidor* (nueva IP) · *Buscar actualización*.

### Autoactualización

El APK se actualiza solo desde la app, sin navegador:

1. Al abrir (o desde **⋮ → Buscar actualización**) consulta `GET /api/app-version`.
2. Si el `versionCode` del servidor supera al instalado, ofrece descargar e instalar.
3. Descarga `GET /download/app.apk` y lanza el instalador de Android vía `FileProvider`.

Para publicar una versión nueva: subí `versionCode`/`versionName` en `android/app/build.gradle` **y** en `app-version.json`, recompilá y copiá el APK a `claude-remote.apk` (lo que sirve el servidor).

## Arquitectura

| Componente | Archivo | Función |
|------------|---------|---------|
| Backend | `server.js` | Express, WebSocket (`/ws`), PTY con `claude`, APIs de uso/proyectos/versión |
| UI | `public/index.html` | Layout móvil + selector de proyectos + panel de control (Tailwind) |
| Cliente | `public/app.js` | Terminal `xterm.js`, WebSocket, selector de proyectos, métricas, botones rápidos (`/compact`, `/clear`, `/cost`, `Esc`, `Tab`, `Ctrl+C`) |
| PWA | `public/manifest.json`, `public/sw.js`, `public/icon.svg` | Instalación en Android |
| Android | `android/` | APK WebView con selector de proyectos y autoactualizador |

### API

| Endpoint | Función |
|----------|---------|
| `GET /api/usage` | Lee `~/.claude/.credentials.json`, consulta la API de uso y devuelve `{ utilization, resets_at, raw }` |
| `GET /api/projects` | Lista `{ projects: [{ name, path }] }`: subcarpetas de nivel 1 de `PROJECTS_DIRS` + proyectos anidados con marcador (`.git`, `package.json`, etc., hasta `PROJECTS_DEPTH`) + carpetas ya conocidas por Claude (leídas de `~/.claude/projects/*/*.jsonl`). Deduplica por ruta |
| `GET /api/app-version` | Versión del APK servido → `{ versionCode, versionName, url }` |
| `GET /download/app.apk` | Descarga el APK (`APK_PATH`) para el autoactualizador |
| `GET /api/sessions` | Sesiones vivas en segundo plano → `{ sessions: [{ path, clients }] }` |
| `POST /api/sessions/stop` | Body `{ path }`: detiene la sesión de esa carpeta |
| `POST /api/push/register` | Body `{ token }`: registra el token FCM del dispositivo |
| `POST /api/push/unregister` | Body `{ token }`: da de baja el token |

**WebSocket** (`/ws`): el cliente envía `{ type: "start", cwd }` para iniciar Claude en la carpeta elegida (solo si está bajo `PROJECTS_DIRS` o es una carpeta conocida por Claude), luego `input`/`resize`.

**Memoria y trabajo en segundo plano:** hay una sesión viva por carpeta que **sobrevive a la desconexión** del WebSocket. Al reconectar, el servidor reenvía la pantalla previa (`{ type: "restore" }`) para no perder lo visible. Si la carpeta ya tiene historial de Claude, la conversación se **reanuda con `--continue`** (recuerda todo el contexto anterior); para empezar de cero, mandar `{ type: "start", cwd, fresh: true }`.

El proceso **sigue trabajando en segundo plano** aunque bloquees el celular o cambies de app: la flecha ← vuelve al selector sin detenerlo. Solo se detiene al pulsar **"Cerrar"** (`{ type: "stop" }`) o el ✕ del selector (`POST /api/sessions/stop`); la memoria queda guardada y se reanuda con `--continue`. Por defecto no se apaga nunca solo (`SESSION_IDLE_MS=0`); poné un valor en ms para forzar un apagado por inactividad. El selector marca las carpetas **"en curso"** (`GET /api/sessions`). Buffer de pantalla acotado a `SESSION_BUFFER_BYTES` (def. 200 KB).

## Notificaciones push (FCM)

Cuando Claude termina o queda esperando tu respuesta emite la **campana de terminal**; si esa sesión **no tiene la app mirándola**, el servidor manda una notificación al celular ("Claude te necesita").

**Puesta en marcha (una vez):**

1. En [Firebase Console](https://console.firebase.google.com) → tu proyecto → **Project settings → General**, registrá una app Android con el paquete `com.claude.remote` y descargá `google-services.json` → ponelo en `android/app/google-services.json`.
2. **Project settings → Service accounts → Generate new private key** → guardá el JSON como `firebase-service-account.json` en la raíz del repo (es el que usa el servidor para **enviar**; nunca lo subas a git).
3. Recompilá e instalá el APK nuevo (trae el SDK de FCM y pide permiso de notificaciones).

> `google-services.json` (recibir) y `firebase-service-account.json` (enviar) están en `.gitignore`. Sin el service account el push queda desactivado y todo lo demás funciona igual.

## Seguridad

⚠️ El endpoint da acceso completo a una terminal con tu sesión de Claude. Exponlo **solo** en red local o Tailscale, **nunca** en internet abierto.

⚠️ Por defecto Claude corre con `--dangerously-skip-permissions` (sin confirmaciones): puede ejecutar acciones sin pedir permiso. Para restaurar los prompts, definí `CLAUDE_CMD=claude`.
