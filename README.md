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
| `SHELL` | `powershell.exe` (Windows) · `bash` (Unix) | Shell que lanza el comando. En Windows se invoca con `-NoLogo -Command`; en Unix con `-lc` |

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
4. Para cambiar la dirección después: menú **⋮ → Cambiar servidor**.

## Arquitectura

| Componente | Archivo | Función |
|------------|---------|---------|
| Backend | `server.js` | Express, WebSocket (`/ws`), PTY con `claude`, endpoint `/api/usage` |
| UI | `public/index.html` | Layout móvil + panel de control (Tailwind) |
| Cliente | `public/app.js` | Terminal `xterm.js`, WebSocket, métricas, botones rápidos (`/compact`, `/clear`, `/cost`, `Esc`, `Tab`, `Ctrl+C`) |
| PWA | `public/manifest.json`, `public/sw.js`, `public/icon.svg` | Instalación en Android |

### API

`GET /api/usage` → lee `~/.claude/.credentials.json`, consulta `https://api.anthropic.com/api/oauth/usage` y responde:

```json
{ "utilization": 0.42, "resets_at": "2026-08-28T18:00:00Z", "raw": { } }
```

## Seguridad

⚠️ El endpoint da acceso completo a una terminal con tu sesión de Claude. Exponlo **solo** en red local o Tailscale, **nunca** en internet abierto.
