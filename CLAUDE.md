# CLAUDE.md

## Reglas inviolables

| # | Regla | Detalle |
|---|-------|---------|
| 1 | Sin redundancias | Los `*.md` deben ser concisos: sin duplicados, relleno ni introducciones innecesarias. Priorizar tablas, listas y bloques de código. |
| 2 | Siempre actualizados | Ante cualquier cambio de código, dependencias o arquitectura, actualizar de inmediato los `*.md` afectados. No cerrar una tarea sin verificar que la documentación refleje el estado actual. |

## Proyecto: Claude Remote

PWA + backend Node.js para controlar Claude CLI desde Android (red local / Tailscale). Guía de uso en [`README.md`](README.md).

### Estructura

```
server.js            Express + WS (/ws) + PTY + APIs usage/projects/app-version + /download/app.apk
package.json         Dependencias: express, node-pty, ws
push.js              Notificaciones push (FCM HTTP v1) sin deps: firma el JWT con crypto nativo; store de tokens
firebase-service-account.json  Credencial para ENVIAR push (ignorada por git; sin ella el push queda desactivado)
app-version.json     versionCode/versionName del APK servido (autoupdate)
tray.ps1             Ícono de bandeja (Windows Forms): arranca/reinicia/detiene y supervisa el servidor (oculto)
tray.vbs             Lanza tray.ps1 oculto (powershell -STA); se copia a shell:startup para autoarranque
claude-remote.apk    APK que sirve el autoactualizador (ignorado por git)
public/index.html    UI móvil + selector de proyectos (Tailwind CDN)
public/app.js        xterm.js, WebSocket, selector de proyectos, métricas, botones rápidos
public/manifest.json manifest PWA
public/sw.js         service worker (instalación PWA)
public/icon.svg      ícono
android/             APK nativo (WebView) con selector de proyectos y autoupdater
```

### Endpoints

| Ruta | Función |
|------|---------|
| `GET /api/usage` | Uso de tokens (lee credenciales, consulta API OAuth) |
| `GET /api/projects` | Lista proyectos: subcarpetas de nivel 1 de `PROJECTS_DIRS` (def.: carpeta padre del repo) + anidados con marcador (`.git`, `package.json`, etc., hasta `PROJECTS_DEPTH`=3) + carpetas que Claude ya conoce (lee `cwd` de `~/.claude/projects/*/*.jsonl`, aunque estén en otra unidad). Deduplica por ruta |
| `GET /api/app-version` | Versión del APK (lee `app-version.json`) |
| `GET /download/app.apk` | Sirve `APK_PATH` para el autoupdate |
| `GET /api/sessions` | Sesiones vivas en segundo plano: `[{path,clients}]` (marca proyectos "en curso" en el selector) |
| `POST /api/sessions/stop` | Body `{path}`: detiene la sesión de esa carpeta (botón ✕ del selector) |
| `POST /api/push/register` | Body `{token}`: registra el token FCM del dispositivo (persiste en `push-tokens.json`) |
| `POST /api/push/unregister` | Body `{token}`: da de baja el token |
| WS `/ws` | `{type:"start",cwd}` inicia Claude en la carpeta (solo si `cwd` está bajo `PROJECTS_DIRS` o es una carpeta conocida por Claude), luego `input`/`resize`/`stop`. Comando por defecto: `claude --dangerously-skip-permissions` (sin prompts de permiso); override con `CLAUDE_CMD`. **Sesión persistente por carpeta:** el proceso sobrevive a la desconexión del WS y al reconectar se reenvía la pantalla (`{type:"restore"}`); si hay historial, la conversación se reanuda con `--continue` (salvo `{type:"start",cwd,fresh:true}`). Sigue vivo en segundo plano hasta `{type:"stop"}` (botón "Cerrar"); `SESSION_IDLE_MS` (def. 0 = nunca) fuerza apagado por inactividad; buffer acotado a `SESSION_BUFFER_BYTES` (def. 200 KB) |

**Push (FCM):** al detectar la campana de terminal (`\x07`) en una sesión **sin clientes conectados** (no la estás mirando), el servidor manda una notificación "Claude te necesita" a los dispositivos registrados (antirrebote 4 s), con `data.path` = carpeta de la sesión. **Al tocar la notificación, la app abre ese proyecto** (`MainActivity` lee el extra `path` → `window.__crOpenProject`). Requiere `firebase-service-account.json` (si falta, el push queda desactivado y el resto funciona igual).

### App Android (`android/`)

Es un **cliente**: envuelve la web del servidor en un `WebView` y recibe notificaciones push (FCM); el servidor de la PC debe seguir corriendo.

| Archivo | Función |
|---------|---------|
| `app/src/main/java/com/claude/remote/MainActivity.java` | Config `IP:puerto`, `WebView`, menú (Cambiar servidor / Buscar actualización), autoupdater, permiso de notificaciones y registro del token FCM |
| `app/src/main/java/com/claude/remote/PushService.java` | `FirebaseMessagingService`: muestra la notificación (con el `path` como extra para abrir el proyecto al tocarla) y registra el token en `/api/push/register` |
| `app/src/main/res/layout/config.xml` | Formulario de dirección del servidor |
| `app/src/main/res/xml/file_paths.xml` | Rutas del `FileProvider` (para instalar el APK descargado) |
| `app/src/main/AndroidManifest.xml` | Permisos (`INTERNET`, `REQUEST_INSTALL_PACKAGES`, `POST_NOTIFICATIONS`), `usesCleartextTraffic`, `FileProvider`, servicio FCM + canal `claude` |
| `app/google-services.json` | Config del proyecto Firebase (ignorada por git; necesaria para compilar) |
| `build.gradle`, `app/build.gradle` | AGP 8.5.2 · compileSdk 35 · minSdk 24 · Java 17 · deps `androidx.core` + `firebase-bom`/`firebase-messaging` · plugin `google-services` |

Requiere SDK de Android (`ANDROID_HOME`) + JDK 17 y `app/google-services.json`. El APK debug queda firmado con la clave de debug (instalable directo).

**Publicar versión nueva:** subir `versionCode`/`versionName` en `app/build.gradle` **y** en `app-version.json`, recompilar y copiar el APK a `claude-remote.apk`.

### Comandos

| Acción | Comando |
|--------|---------|
| Instalar | `npm install` |
| Ejecutar | `npm start` |
| Desarrollo | `npm run dev` |
| Compilar APK | `cd android && ./gradlew.bat assembleDebug` → `app/build/outputs/apk/debug/app-debug.apk` |
