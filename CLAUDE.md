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
server.js            Express + WS (/ws) + PTY + APIs usage/projects/app-version/files + /download/app.apk
package.json         Dependencias: express, node-pty, ws
security.js          Guard de Express/WS: Host permitido (IP, localhost, claude-remote-pc[.*.ts.net], `ALLOWED_HOSTS`) → Origin del mismo sitio → clave del celular (`X-CR-Key` o cookie `cr_key`). **Una clave por celular**: `devices.json` [{id,name,hash,created}] guarda solo el sha256 (se relee al cambiar su mtime); `app-key.txt` = clave única vieja, aceptada como celular `legacy` hasta revocarla (ya no se crea). `req.crDevice` = celular del pedido; `deviceActive(id)` para cortar WS de revocados. `APP_ONLY=0` desactiva la clave. Vinculación: `pairing.json` {code,expires} (6 dígitos, 5 min, un uso, 5 intentos) → clave nueva
pair.js              `npm run pair` / tray "Vincular celular": genera el código (`--quiet` = solo el código)
devices.js           `npm run devices` lista celulares; `node devices.js revoke <id>` desvincula (`--json` para la bandeja; `legacy` borra `app-key.txt`)
devices.json         Celulares vinculados (huellas de sus claves; ignorado por git)
push.js              Notificaciones push (FCM HTTP v1) sin deps: firma el JWT con crypto nativo; store de tokens
firebase-service-account.json  Credencial completa para ENVIAR push (solo PC del autor; ignorada por git)
push-sender.json     Credencial limitada (cuenta `claude-remote-push`, rol solo "Firebase Cloud Messaging API Admin"): va en el instalador para que el push ande en otras PC; ignorada por git. `push.js` usa la completa si existe, si no ésta
config.json          `{port}` propio de la PC (lo crea server.js al instalarse; tray "Cambiar puerto…" lo reescribe). Ignorado por git
updates/             APKs bajados de GitHub para el autoupdate (ignorado por git)
app-version.json     versionCode/versionName del APK servido (autoupdate)
tray.ps1             Ícono de bandeja (Windows Forms): arranca/reinicia/detiene y supervisa el servidor (oculto; Node = `node\node.exe` propio o el del PATH; solo mata servidores de su carpeta); vincular celular, "Celulares vinculados…" (lista y desvincula vía devices.js), dirección de la tailnet, aviso/login de Tailscale (sondea el estado en puerto+99 cada 15 s), aviso si falta Claude Code, "Cambiar puerto…" (uno libre al azar → `config.json`) y, si el servidor sale con 98 (puerto ocupado), avisa y no lo relanza
tray.vbs             Lanza tray.ps1 oculto (powershell -STA) desde su propia carpeta; autoarranque = acceso directo en shell:startup
installer/           Instalador del servidor (Inno Setup 6): build.ps1 arma stage/ (lista blanca: sin secretos ni estado; Node portable, deps sin prebuilds ajenos, claude-remote-ts.exe, APK **release** de la versión de app/build.gradle + su app-version.json generado, `push-sender.json` si existe; nunca la credencial completa) → Output/<productName>-v<version>.exe; ClaudeRemoteServer.iss: por usuario en %LOCALAPPDATA%\Programs\ClaudeRemote, autoarranque opcional, cierra el tray/servidor de {app} al actualizar/desinstalar, avisa si falta Claude Code
claude-remote.apk    APK que sirve el autoactualizador (ignorado por git)
tailnet-host/        Tailscale integrado de la PC (Go + tsnet) → claude-remote-ts.exe (build.ps1); estado/login en tailscale-state/ (ambos ignorados por git)
public/index.html    UI móvil + selector de proyectos. Sin CDNs: `/tailwind.css` y `/vendor/*` (@xterm/xterm 5.5, @xterm/addon-fit, codemirror desde node_modules, versiones fijas; xterm 6 cambia el scroll del que dependen los botones/arrastre)
public/tailwind.css  Generado (`npm run build:css`, config `tailwind.config.cjs` + `tailwind.input.css`): **regenerar al usar clases nuevas** en public/
public/app.js        xterm.js, WebSocket, selector de proyectos, métricas, barra de teclas (Esc, ⇧Tab, flechas, ⏎, Tab, ^C) + panel "⌨ Más" (todos los atajos del CLI), menú "/ Comandos" (del CLI + `/api/commands`), "📁 Archivos" (explorador + editor CodeMirror 5 cargado de `/vendor/codemirror` al abrir el primer archivo; vistas `picker/terminal/files/editor` vía `setView`, atrás = `goBack`), adjuntar archivos (`/api/upload` → ruta al prompt), aviso de build (WS `build`), "📦 Releases" (2 últimas de GitHub vía `/api/releases`; cada archivo → `CRNative.saveToDownloads`, o el navegador si no hay puente), links, copiar y pegar vía puente `CRNative`
public/manifest.json manifest PWA
public/sw.js         service worker (instalación PWA)
public/icon.svg      ícono
android/             APK nativo (WebView) con selector de proyectos y autoupdater
android/tailnet/     Tailscale integrado (Go + tsnet → tailnet.aar vía gomobile; build.ps1)
```

### Endpoints

| Ruta | Función |
|------|---------|
| `GET /api/usage` | Uso de tokens (lee credenciales, consulta API OAuth). `utilization` es porcentaje 0–100; ante 429 devuelve la última respuesta buena marcada `stale` |
| `GET /api/projects` | Lista proyectos: subcarpetas de nivel 1 de `PROJECTS_DIRS` (def.: carpeta padre del repo si hay `.git`; instalado: ninguna) + anidados con marcador (`.git`, `package.json`, etc., hasta `PROJECTS_DEPTH`=3) + carpetas que Claude ya conoce (`listKnownProjectPaths`: confiables en `~/.claude.json` `projects[ruta].hasTrustDialogAccepted` + `cwd` de `~/.claude/projects/*/*.jsonl`, aunque estén en otra unidad). Deduplica por ruta |
| `POST /api/pair` | Body `{code,name}`: si el código de `pairing.json` es válido crea el celular en `devices.json` y devuelve su `{key}` propia (la app la guarda y manda como cookie `cr_key`). Sin clave, igual que `/api/app-version` y `/download/app.apk` |
| `GET /api/auth` | `{ok:true}` si la clave es válida (401 si no: la app pide vincular) |
| `GET /api/releases` | 2 últimas releases (sin borradores) de `RELEASES_REPO` (def. `Pisciotta545/claude-remote`) vía API de GitHub: `{repo,releases:[{tag,name,date,url,notes,assets:[{name,size,url}]}]}`. Caché 10 min (límite 60/h sin token); ante error devuelve la última buena con `stale` |
| `GET /api/app-version` | Versión más nueva de la app: la local (`app-version.json` + `claude-remote.apk`) o la de la última release de GitHub con `.apk` + `app-version.json` (gana el `versionCode` mayor; `APP_UPDATES=local` la desactiva). `{versionCode,versionName,source,url:"/download/app.apk"}` |
| `GET /api/commands?cwd=` | Comandos propios y skills para el menú "/": `.claude/commands/**/*.md` y `.claude/skills/**/SKILL.md` del proyecto y de `~/.claude` (`{cmd,desc,scope}`) |
| `POST /api/upload?name=` | Body crudo (`application/octet-stream`, máx. 50 MB): guarda el archivo en `UPLOAD_DIR` (def. `%TEMP%/claude-remote-uploads`) y devuelve `{path}` |
| `GET /api/files?cwd=&dir=` | Lista una carpeta del proyecto (`dir` relativo a `cwd`; `cwd` debe pasar `isAllowed`, nunca sale de él): `{entries:[{name,dir,size}]}`, carpetas primero |
| `GET /api/file?cwd=&path=` | `{content,mtime,size}`; binario (byte 0) → `{binary}`; > `EDITOR_MAX_BYTES` (def. 2 MB) → `{tooBig}`; `&raw=1` sirve el archivo tal cual (imágenes) |
| `PUT /api/file?cwd=&path=&mtime=` | Body crudo = bytes a escribir. Si el `mtime` actual difiere (lo cambió Claude) → 409, salvo `&force=1`. Devuelve `{mtime}` |
| `GET /api/builds/:id` | Descarga un build detectado (solo ids registrados por el vigilante, nunca rutas arbitrarias) |
| `GET /download/app.apk` | Sirve el APK de esa versión: si es de GitHub lo baja una vez a `updates/` (verifica tamaño) y lo sirve; si falla, el local. La app siempre baja por el servidor (tailnet, sin mandar su clave a GitHub), así que sirve también para apps viejas |
| `GET /api/tailnet` | Estado del Tailscale integrado de la PC: `{state, authURL, ip, name}` o `{state:"off"}` |
| `GET /api/sessions` | Sesiones vivas en segundo plano: `[{path,clients}]` (marca proyectos "en curso" en el selector) |
| `POST /api/sessions/stop` | Body `{path}`: detiene la sesión de esa carpeta (botón ✕ del selector) |
| `GET /api/push/target?id=` | Canjea el id opaco de una notificación (`cr:…`) por la carpeta (la ruta no viaja por Google). 404 si venció (se pierde al reiniciar) |
| `POST /api/push/register` | Body `{token}`: registra el token FCM del dispositivo (persiste en `push-tokens.json`) |
| `POST /api/push/unregister` | Body `{token}`: da de baja el token |
| WS `/ws` | `{type:"start",cwd,cols,rows}` inicia Claude en la carpeta (solo si `cwd` está bajo `PROJECTS_DIRS` o es una carpeta conocida por Claude); el PTY arranca con `cols`/`rows` del cliente (def. 80×24) para no descuadrar la pantalla. Luego `input`/`resize`/`stop`. Comando por defecto: `claude --dangerously-skip-permissions` (sin prompts de permiso); override con `CLAUDE_CMD`. El PTY recibe el entorno sin las marcas de sesión de Claude (`ptyEnv`: `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, …, más `NO_COLOR`/`GIT_TERMINAL_PROMPT` del shell de Claude Code): si el servidor se lanzó desde Claude Code, las heredaría y cada sesión quedaría como subsesión sin guardar la conversación y sin colores. **Sesión persistente por carpeta:** el proceso sobrevive a la desconexión del WS y al reconectar se reenvía la pantalla (`{type:"restore"}`); si hay historial, la conversación se reanuda con `--continue` (salvo `{type:"start",cwd,fresh:true}`). Sigue vivo en segundo plano hasta `{type:"stop"}` (botón "Cerrar"); `{type:"build-ack"}` descarta el build pendiente; `SESSION_IDLE_MS` (def. 0 = nunca) fuerza apagado por inactividad; buffer acotado a `SESSION_BUFFER_BYTES` (def. 200 KB) |

**Builds → celular:** cada sesión vigila su carpeta (`fs.watch` recursivo). Si aparece o se reescribe un archivo con extensión de `BUILD_EXTS` (def. `.apk`; `;` separa; vacío = off), ignorando `node_modules`/`intermediates`/`tmp`/`.git`, espera 3 s a que se asiente, deduplica copias idénticas (sha1) y manda WS `{type:"build",builds:[{id,name,rel,size,url}]}` → la app pregunta "¿Descargarlo en el celular?" (APK: `CRNative.installApk` lo baja e instala; sin puente: navegador). Queda pendiente (se reenvía al reconectar) hasta `build-ack`; sin clientes mirando, además manda push "Build listo 📦".

**Puerto:** `PORT` > `config.json` > 3000 en un clon de git > uno libre al azar (20000–29999, con +99 libre) la primera vez instalado, guardado en `config.json`. El estado del Tailscale integrado usa `PORT+99` (`TAILNET_STATUS`). Puerto ocupado → sale con código 98.

**Endurecimiento:** CSP en todas las respuestas (`script-src 'self'`, `connect-src 'self'`, sin CDNs) + `nosniff` + `no-referrer`; la vista previa cruda (`/api/file?raw=1`) va con CSP `sandbox`. `projectPath` también valida el destino real (`realpath`) de symlinks/junctions. Con `HOST` no local avisa que la clave viaja sin cifrar.

**Red:** el servidor escucha solo en `127.0.0.1` (`HOST`); desde afuera se entra únicamente por la tailnet vía `claude-remote-pc`. Todo pedido (HTTP y WS) pasa por `security.js`: sin la clave de la app vinculada → 401 (también navegadores de la PC). No abrirlo a la LAN (`HOST=0.0.0.0`) salvo red confiable.

**Tailscale integrado de la PC:** si existe `claude-remote-ts.exe` (y `TAILNET≠0`), `server.js` lo lanza con `-watch-stdin` (muere con el servidor) y lo re-chequea cada 15 s. El nodo `claude-remote-pc` escucha `:PORT` en la tailnet y reenvía a `127.0.0.1:PORT`, sin la app de Tailscale. Su estado vive en `127.0.0.1:3099/status` (`?peers=1` agrega los equipos de la tailnet: online, relay, tráfico; registro detallado en `tailscale-state/tailnet.log`, con cada conexión entrante) (`TAILNET_STATUS`), que además es candado de instancia única: si ya corre uno (p. ej. lanzado a mano) no se lanza otro. El link de login se imprime en la consola del servidor y en `/api/tailnet`.

**Push (FCM):** al detectar la campana de terminal (`\x07`) en una sesión **sin clientes conectados** (no la estás mirando), el servidor manda una notificación "Claude te necesita" a los dispositivos registrados (antirrebote 4 s), con `data.path` = id opaco `cr:…` de la carpeta (`pushTarget`). **Al tocar la notificación, la app abre ese proyecto** (`MainActivity` lee el extra `path` → `window.__crOpenProject`, que canjea el id en `/api/push/target`). Requiere `firebase-service-account.json` o `push-sender.json` (si faltan, el push queda desactivado y el resto funciona igual).

### App Android (`android/`)

Es un **cliente**: envuelve la web del servidor en un `WebView` y recibe notificaciones push (FCM); el servidor de la PC debe seguir corriendo.

| Archivo | Función |
|---------|---------|
| `app/src/main/java/com/claude/remote/MainActivity.java` | Config `IP:puerto`, `WebView` (`TerminalWebView`: teclado sin sugerencias `VISIBLE_PASSWORD\|NO_SUGGESTIONS`, porque la composición del IME duplicaba el texto en xterm al tocar `?`/signos), menú (Cambiar servidor / Buscar actualización), autoupdater, permiso de notificaciones y registro del token FCM. Puente JS `window.CRNative` (`openUrl`/`copy`/`requestPaste`→`window.__crPaste`/`installApk(url,name)`/`saveToDownloads(url,name)`) para abrir links afuera, copiar/pegar con el portapapeles del sistema, instalar builds y guardar archivos de releases (solo `https`) en la carpeta pública Descargas con `DownloadManager` (notificación del sistema; Android 7–9 pide `WRITE_EXTERNAL_STORAGE`, pendiente en `pendingDownload` hasta `onRequestPermissionsResult`); descargas de APK (update o build) con notificaciones de inicio/progreso/fin (canales `descargas` silencioso y `descargas_listas`): tocar la de fin abre el instalador (o la app con extra `installApk` si falta el permiso de instalar); `onShowFileChooser` abre el selector del sistema para "Adjuntar"; `shouldOverrideUrlLoading` manda toda navegación ajena al servidor al navegador externo |
| `app/src/main/java/com/claude/remote/PushService.java` | `FirebaseMessagingService`: muestra la notificación (con el `path` como extra para abrir el proyecto al tocarla) y registra el token en `/api/push/register` |
| `app/src/main/java/com/claude/remote/AppLock.java` | Bloqueo con huella/rostro/PIN del celular (`BiometricPrompt` `BIOMETRIC_WEAK\|DEVICE_CREDENTIAL`; Android 7–9: `createConfirmDeviceCredentialIntent`). Pide al abrir y al volver tras 1 min afuera; capa opaca sobre la `DecorView` (la WebView sigue viva debajo); oculta la vista previa en recientes (Android 13+). Requiere el permiso `USE_BIOMETRIC` (sin él, `authenticate` lanza `SecurityException`); si la huella falla, cae a la pantalla de PIN. Pref `appLock` (def. activado), menú ⋮ para apagarlo. Sin bloqueo de pantalla en el celular, no bloquea y avisa |
| `app/src/main/java/com/claude/remote/TailnetManager.java` | Tailscale integrado: arranca el nodo tsnet (`Tailnet.start`), le pasa interfaces de red y cambios de red (Android 11+ no deja a Go leerlos), estado/login/logout/registro, y `open()` agrega la clave (`X-CR-Key`) y la cookie `cr_ts` **solo si `isServer(url)`** (el reenvío local o la dirección configurada): nunca a otra URL |
| `app/src/main/res/layout/config.xml` | Formulario: dirección del servidor, casilla "Tailscale integrado" y clave `tskey-auth-…` opcional |
| `app/src/main/res/drawable/ic_launcher.xml` | Ícono de la app (vector): sunburst de Claude (arcilla) sobre tile crema |
| `app/src/main/res/drawable/ic_notification.xml` | Ícono chico de notificación (vector blanco/silueta); también `default_notification_icon` de FCM |
| `app/src/main/res/values*/themes.xml` | `AppTheme` (Material DarkActionBar). En `values-v35` opta por salir del edge-to-edge forzado de Android 15 (`windowOptOutEdgeToEdgeEnforcement`): si no, la web queda debajo de la barra "Claude Remote" y el teclado la tapa |
| `app/src/main/res/xml/file_paths.xml` | Rutas del `FileProvider` (para instalar el APK descargado) |
| `app/src/main/AndroidManifest.xml` | Permisos (`INTERNET`, `REQUEST_INSTALL_PACKAGES`, `POST_NOTIFICATIONS`, `USE_BIOMETRIC`, `WRITE_EXTERNAL_STORAGE` con `maxSdkVersion=28`), `usesCleartextTraffic`, `allowBackup=false` + `xml/data_extraction_rules.xml` (nada a la nube ni a otro celular), tema `AppTheme`, `adjustResize` (el teclado achica la web), `FileProvider`, servicio FCM + canal `claude` |
| `app/google-services.json` | Config del proyecto Firebase (ignorada por git; necesaria para compilar) |
| `build.gradle`, `app/build.gradle` | AGP 8.5.2 · compileSdk 35 · minSdk 24 · Java 17 · deps `androidx.core` + `firebase-bom`/`firebase-messaging` + `libs/tailnet.aar` (jniLibs comprimidas) · plugin `google-services` · salida `<rootProject.name>-v<versionName>.apk` · release firmado con `keystore.properties` (fuera de git → `%USERPROFILE%\.android\claude-remote-release.jks`, cert SHA-256 `52:EA:48:…:99:2F`), no depurable |
| `tailnet/tailnet.go` | tsnet en espacio de usuario (sin VPN ni app de Tailscale). API gomobile: `Start(dir,hostname,authKey,target,secret,port)`, `Status()` JSON, `Login`, `Logout`, `SetInterfaces`, `NetworkChanged`, `Logs`. Reenvío `127.0.0.1:38080` → `target` (host:puerto de la PC en la tailnet); rechaza con 403 las conexiones sin cookie `cr_ts=<secreto>` (otras apps del celular no pueden usarlo) |

**Tailscale integrado:** con la casilla activa, `MainActivity` muestra "Conectando…", arranca tsnet (estado en `filesDir/tailscale`), ofrece "Iniciar sesión en Tailscale" (abre el `authURL` en el navegador) y, en `Running`, fija la cookie en el WebView y carga `http://127.0.0.1:<puerto>`. Todas las llamadas nativas (update, descargas, push) pasan por el reenvío. Menú: *Tailscale: estado y registro* / *cerrar sesión*. Solo arm64. **Diagnóstico de cierres:** `Tailnet.init(dir)` manda los panics de Go a `filesDir/tailscale/crash.txt` (`debug.SetCrashOutput`) y el registro a `tailnet.log`; un handler Java guarda `crash-java.txt`. Al reabrir, `TailnetManager.crashReport` arma el reporte y lo guarda en `last-crash.txt` (no se abre solo: un toast avisa y se ve en ⋮ → *Ver último cierre*, con "Copiar"); si se cerró en los primeros 30 s de Tailscale (marca `tsStarting`), abre la configuración en vez de reintentar

Requiere SDK de Android (`ANDROID_HOME`, con NDK) + JDK 17, `app/google-services.json` y `app/libs/tailnet.aar` (ignorado por git; se genera con `tailnet/build.ps1`, que usa Go en `%USERPROFILE%\sdk\go` + gomobile). **El APK que se reparte es el release** (firmado con la clave de producción, sin depuración). El debug (clave de debug, depurable) es solo para probar: no se pueden mezclar (firma distinta → hay que desinstalar). Perder el `.jks` o `keystore.properties` = no más actualizaciones: guardar copia.

**Publicar versión nueva:** subir `versionCode`/`versionName` en `app/build.gradle` **y** en `app-version.json`, `./gradlew.bat assembleRelease` y copiar `app/build/outputs/apk/release/ClaudeRemote-v<versión>.apk` a `claude-remote.apk`. Para las demás PC: `powershell installer/build.ps1` y `powershell installer/release.ps1 -Publish` (release con APK + `app-version.json` + instalador + `SHA256SUMS.txt`, huellas en las notas; sin `app-version.json` la release no cuenta para el autoupdate).

### Comandos

| Acción | Comando |
|--------|---------|
| Instalar | `npm install` |
| Ejecutar | `npm start` |
| Desarrollo | `npm run dev` |
| Compilar Tailscale integrado (celular) | `powershell android/tailnet/build.ps1` → `android/app/libs/tailnet.aar` (solo al cambiar `tailnet.go`) |
| Compilar Tailscale integrado (PC) | `powershell tailnet-host/build.ps1` → `claude-remote-ts.exe` |
| Compilar instalador del servidor | `powershell installer/build.ps1` → `installer/Output/ClaudeRemoteServer-v<version>.exe` (nombre/versión de `package.json` `productName`/`version`) |
| Compilar APK | `cd android && ./gradlew.bat assembleRelease` → `app/build/outputs/apk/release/ClaudeRemote-v<versión>.apk` (debug para probar: `assembleDebug`) |
| CSS de la web | `npm run build:css` → `public/tailwind.css` |
| Celulares vinculados | `npm run devices` · `node devices.js revoke <id>` |
| Armar / publicar release | `powershell installer/release.ps1` (arma `installer/release/`) · `-Publish` la sube a GitHub |
