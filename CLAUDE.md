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
app-version.json     versionCode/versionName del APK servido (autoupdate)
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
| `GET /api/projects` | Lista subcarpetas de `PROJECTS_DIRS` (def.: carpeta del repo) |
| `GET /api/app-version` | Versión del APK (lee `app-version.json`) |
| `GET /download/app.apk` | Sirve `APK_PATH` para el autoupdate |
| WS `/ws` | `{type:"start",cwd}` inicia Claude en la carpeta, luego `input`/`resize` |

### App Android (`android/`)

APK mínimo sin dependencias externas (solo APIs de plataforma). Es un **cliente**: envuelve la web del servidor en un `WebView`; el servidor de la PC debe seguir corriendo.

| Archivo | Función |
|---------|---------|
| `app/src/main/java/com/claude/remote/MainActivity.java` | Config `IP:puerto`, `WebView`, menú (Cambiar servidor / Buscar actualización) y autoupdater |
| `app/src/main/res/layout/config.xml` | Formulario de dirección del servidor |
| `app/src/main/res/xml/file_paths.xml` | Rutas del `FileProvider` (para instalar el APK descargado) |
| `app/src/main/AndroidManifest.xml` | Permisos (`INTERNET`, `REQUEST_INSTALL_PACKAGES`), `usesCleartextTraffic`, `FileProvider` |
| `build.gradle`, `app/build.gradle` | AGP 8.5.2 · compileSdk 35 · minSdk 24 · Java 17 · dep `androidx.core` |

Requiere SDK de Android (`ANDROID_HOME`) + JDK 17. El APK debug queda firmado con la clave de debug (instalable directo).

**Publicar versión nueva:** subir `versionCode`/`versionName` en `app/build.gradle` **y** en `app-version.json`, recompilar y copiar el APK a `claude-remote.apk`.

### Comandos

| Acción | Comando |
|--------|---------|
| Instalar | `npm install` |
| Ejecutar | `npm start` |
| Desarrollo | `npm run dev` |
| Compilar APK | `cd android && ./gradlew.bat assembleDebug` → `app/build/outputs/apk/debug/app-debug.apk` |
