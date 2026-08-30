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
server.js            Express + WebSocket (/ws) + PTY + GET /api/usage
package.json         Dependencias: express, node-pty, ws
public/index.html    UI móvil (Tailwind CDN)
public/app.js        xterm.js, WebSocket, métricas, botones rápidos
public/manifest.json manifest PWA
public/sw.js         service worker (instalación PWA)
public/icon.svg      ícono
android/             APK nativo (WebView) que envuelve la PWA
```

### App Android (`android/`)

APK mínimo sin dependencias externas (solo APIs de plataforma). Es un **cliente**: envuelve la web del servidor en un `WebView`; el servidor de la PC debe seguir corriendo.

| Archivo | Función |
|---------|---------|
| `app/src/main/java/com/claude/remote/MainActivity.java` | Pantalla de config (guarda `IP:puerto`), `WebView`, menú "Cambiar servidor" |
| `app/src/main/res/layout/config.xml` | Formulario de dirección del servidor |
| `app/src/main/AndroidManifest.xml` | Permisos (`INTERNET`), `usesCleartextTraffic` para http/ws en red local |
| `build.gradle`, `app/build.gradle` | AGP 8.5.2 · compileSdk 35 · minSdk 24 · Java 17 |

Requiere SDK de Android (`ANDROID_HOME`) + JDK 17. El APK debug queda firmado con la clave de debug (instalable directo).

### Comandos

| Acción | Comando |
|--------|---------|
| Instalar | `npm install` |
| Ejecutar | `npm start` |
| Desarrollo | `npm run dev` |
| Compilar APK | `cd android && ./gradlew.bat assembleDebug` → `app/build/outputs/apk/debug/app-debug.apk` |
