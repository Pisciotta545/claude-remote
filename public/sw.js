// Service worker mínimo: habilita la instalación como PWA.
// No cachea la app para evitar servir versiones obsoletas de la terminal.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
