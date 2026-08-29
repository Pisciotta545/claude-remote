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
```

### Comandos

| Acción | Comando |
|--------|---------|
| Instalar | `npm install` |
| Ejecutar | `npm start` |
| Desarrollo | `npm run dev` |
