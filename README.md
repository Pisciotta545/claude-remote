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

### Variables de entorno

| Variable | Defecto | Descripción |
|----------|---------|-------------|
| `PORT` | `3000` | Puerto HTTP/WebSocket |
| `HOST` | `0.0.0.0` | Interfaz de escucha |
| `CLAUDE_CMD` | `claude` | Comando a ejecutar en el PTY |
| `SHELL` | `powershell.exe` (Windows) · `bash` (Unix) | Shell que lanza el comando. Los argumentos se eligen según el shell real: PowerShell → `-NoLogo -Command`, cmd → `/c`, POSIX → `-lc` |
| `PROJECTS_DIRS` | carpeta que contiene el repo | Raíces (separadas por `;`) cuyas subcarpetas se listan como proyectos |
| `CLAUDE_CWD` | home del usuario | Carpeta por defecto si no se elige proyecto |
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
| `GET /api/projects` | Lista subcarpetas de `PROJECTS_DIRS` → `{ projects: [{ name, path }] }` |
| `GET /api/app-version` | Versión del APK servido → `{ versionCode, versionName, url }` |
| `GET /download/app.apk` | Descarga el APK (`APK_PATH`) para el autoactualizador |

**WebSocket** (`/ws`): el cliente envía `{ type: "start", cwd }` para iniciar Claude en la carpeta elegida, luego `input`/`resize`.

## Seguridad

⚠️ El endpoint da acceso completo a una terminal con tu sesión de Claude. Exponlo **solo** en red local o Tailscale, **nunca** en internet abierto.
