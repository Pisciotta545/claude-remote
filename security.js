// Seguridad del servidor:
// 1. Host/Origin: rechaza pedidos con un Host ajeno (DNS rebinding) y conexiones
//    que vengan de otro sitio (una página web abierta en la PC no puede usar la
//    terminal ni leer archivos).
// 2. Solo la app: cada pedido debe traer la clave de SU celular (cookie `cr_key`
//    o header `X-CR-Key`). Cada celular obtiene una clave propia al vincularse con
//    un código de 6 dígitos que se genera en la PC (bandeja → "Vincular celular" o
//    `npm run pair`); en devices.json solo queda su huella (sha256). Desvincular un
//    celular (bandeja → "Celulares vinculados…" o `npm run devices`) lo echa al
//    instante, sin tocar a los demás.
import { readFileSync, writeFileSync, unlinkSync, statSync } from "fs";
import { randomBytes, timingSafeEqual, createHash } from "crypto";
import { isIP } from "net";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Clave única de versiones anteriores (se sigue aceptando como el celular
// "vinculado antes" hasta desvincularlo; ya no se crea).
export const APP_KEY_PATH = process.env.APP_KEY_PATH || join(__dirname, "app-key.txt");
export const DEVICES_PATH = process.env.DEVICES_PATH || join(__dirname, "devices.json");
export const PAIRING_PATH = join(__dirname, "pairing.json");
// APP_ONLY=0 deja entrar sin clave (p. ej. para probar desde el navegador de la PC).
export const APP_ONLY = process.env.APP_ONLY !== "0";
const TS_HOSTNAME = (process.env.TAILNET_HOSTNAME || "claude-remote-pc").toLowerCase();
const EXTRA_HOSTS = (process.env.ALLOWED_HOSTS || "")
  .split(";").map((h) => h.trim().toLowerCase()).filter(Boolean);
// Rutas sin clave: la app vieja tiene que poder actualizarse, y la nueva vincularse.
const OPEN_PATHS = new Set(["/api/app-version", "/download/app.apk", "/api/pair"]);
const MAX_PAIR_TRIES = 5;

// --- Celulares vinculados ---------------------------------------------------
// devices.json = [{id, name, hash, created}]. Se relee cuando cambia (mtime), así
// desvincular desde la bandeja o `npm run devices` rige al instante.
const sha256 = (k) => createHash("sha256").update(String(k)).digest("hex");
function cachedRead(path, parse, empty) {
  const cache = { mtime: -1, value: empty };
  return () => {
    let mtime;
    try { mtime = statSync(path).mtimeMs; } catch { cache.mtime = -1; cache.value = empty; return empty; }
    if (mtime !== cache.mtime) {
      try { cache.value = parse(readFileSync(path, "utf8")); } catch { cache.value = empty; }
      cache.mtime = mtime;
    }
    return cache.value;
  };
}
export const readDevices = cachedRead(DEVICES_PATH, (t) => JSON.parse(t), []);
const readLegacyKey = cachedRead(APP_KEY_PATH, (t) => (t.trim().length >= 32 ? t.trim() : null), null);

export function listDevices() {
  const list = readDevices().map(({ id, name, created }) => ({ id, name, created }));
  if (readLegacyKey()) list.unshift({ id: "legacy", name: "Celular vinculado antes de las claves por celular", created: null });
  return list;
}

export function revokeDevice(id) {
  if (id === "legacy") {
    try { unlinkSync(APP_KEY_PATH); return true; } catch { return false; }
  }
  const all = readDevices();
  const rest = all.filter((d) => d.id !== id);
  if (rest.length === all.length) return false;
  writeFileSync(DEVICES_PATH, JSON.stringify(rest, null, 2), { mode: 0o600 });
  return true;
}

// id del celular dueño de la clave, o null.
function deviceForKey(k) {
  if (!k) return null;
  const h = sha256(k);
  for (const d of readDevices()) if (safeEqual(h, d.hash)) return d.id;
  const legacy = readLegacyKey();
  return legacy && safeEqual(k, legacy) ? "legacy" : null;
}

// ¿Sigue vinculado? (para cortar los WebSocket de un celular recién desvinculado)
export function deviceActive(id) {
  if (!APP_ONLY) return true;
  if (id === "legacy") return !!readLegacyKey();
  return readDevices().some((d) => d.id === id);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// Host permitido: IP literal (sin DNS no hay rebinding), localhost, el nombre de
// la PC en la tailnet (corto o <nombre>.<tailnet>.ts.net) y ALLOWED_HOSTS.
export function hostOk(req) {
  let h = String(req.headers.host || "").toLowerCase();
  if (!h) return false;
  h = h.startsWith("[") ? h.slice(1, h.indexOf("]")) : h.replace(/:\d+$/, "");
  if (isIP(h)) return true;
  return h === "localhost" || h === TS_HOSTNAME || EXTRA_HOSTS.includes(h) ||
    (h.startsWith(TS_HOSTNAME + ".") && h.endsWith(".ts.net"));
}

// Origin (si viene) debe ser el mismo sitio. Las apps nativas no lo mandan.
export function originOk(req) {
  const o = req.headers.origin;
  if (o === undefined) return true;
  try { return new URL(o).host.toLowerCase() === String(req.headers.host || "").toLowerCase(); }
  catch { return false; } // incluye Origin "null"
}

// Deja en req.crDevice el celular que hizo el pedido.
export function keyOk(req) {
  if (!APP_ONLY) return true;
  req.crDevice = deviceForKey(req.headers["x-cr-key"] || cookie(req.headers.cookie, "cr_key"));
  return !!req.crDevice;
}

const DENIED_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Claude Remote</title><body style="font-family:sans-serif;background:#0f172a;color:#e2e8f0;padding:2rem">
<h2>🔒 Solo desde la app</h2><p>Claude Remote solo se puede usar desde la app de Android vinculada.</p>
<p style="color:#94a3b8">Si ya tenés la app, actualizala desde ⋮ → Buscar actualización.</p>`;

// Middleware de Express: Host → Origin → clave.
export function guard(req, res, next) {
  if (!hostOk(req)) return res.status(403).type("text").send("Host no permitido");
  if (!originOk(req)) return res.status(403).type("text").send("Origen no permitido");
  if (OPEN_PATHS.has(req.path) || keyOk(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "app no vinculada" });
  res.status(401).type("html").send(DENIED_HTML);
}

// Para el WebSocket (/ws): mismas reglas, sin excepciones.
export const wsAllowed = (req) => hostOk(req) && originOk(req) && keyOk(req);

// --- Vinculación -----------------------------------------------------------
// pairing.json = {code, expires}: lo escribe la PC (tray o `npm run pair`); solo
// un proceso local puede crearlo. Un código sirve una vez, vence y admite pocos intentos.
let pairTries = { code: null, n: 0 };

export function newPairingCode(minutes = 5) {
  const code = String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, "0");
  writeFileSync(PAIRING_PATH, JSON.stringify({ code, expires: Date.now() + minutes * 60_000 }));
  return code;
}

export function pairHandler(req, res) {
  let p;
  try { p = JSON.parse(readFileSync(PAIRING_PATH, "utf8")); } catch { p = null; }
  if (!p || !p.code || Date.now() > p.expires) {
    return res.status(403).json({ error: "No hay un código activo: en la PC elegí «Vincular celular» en el ícono de la bandeja" });
  }
  if (pairTries.code !== p.code) pairTries = { code: p.code, n: 0 };
  const sent = String(req.body?.code || "").replace(/\D/g, "");
  if (!safeEqual(sent, p.code)) {
    if (++pairTries.n >= MAX_PAIR_TRIES) {
      try { unlinkSync(PAIRING_PATH); } catch { /* ya no está */ }
      return res.status(403).json({ error: "Demasiados intentos: generá un código nuevo en la PC" });
    }
    return res.status(403).json({ error: `Código incorrecto (quedan ${MAX_PAIR_TRIES - pairTries.n} intentos)` });
  }
  try { unlinkSync(PAIRING_PATH); } catch { /* ya no está */ }
  const name = String(req.body?.name || "Celular").replace(/[\u0000-\u001f]/g, "").slice(0, 60);
  const key = randomBytes(32).toString("hex");
  const devices = [...readDevices(), { id: randomBytes(6).toString("hex"), name, hash: sha256(key), created: new Date().toISOString() }];
  writeFileSync(DEVICES_PATH, JSON.stringify(devices, null, 2), { mode: 0o600 });
  console.log(`[vinculación] celular vinculado: ${name}`);
  res.json({ key });
}
