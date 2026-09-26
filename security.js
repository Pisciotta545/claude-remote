// Seguridad del servidor:
// 1. Host/Origin: rechaza pedidos con un Host ajeno (DNS rebinding) y conexiones
//    que vengan de otro sitio (una página web abierta en la PC no puede usar la
//    terminal ni leer archivos).
// 2. Solo la app: cada pedido debe traer la clave de la app (cookie `cr_key` o
//    header `X-CR-Key`). La app la obtiene vinculándose con un código de 6
//    dígitos que se genera en la PC (bandeja → "Vincular celular" o `npm run pair`).
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { randomBytes, timingSafeEqual } from "crypto";
import { isIP } from "net";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const APP_KEY_PATH = process.env.APP_KEY_PATH || join(__dirname, "app-key.txt");
export const PAIRING_PATH = join(__dirname, "pairing.json");
// APP_ONLY=0 deja entrar sin clave (p. ej. para probar desde el navegador de la PC).
export const APP_ONLY = process.env.APP_ONLY !== "0";
const TS_HOSTNAME = (process.env.TAILNET_HOSTNAME || "claude-remote-pc").toLowerCase();
const EXTRA_HOSTS = (process.env.ALLOWED_HOSTS || "")
  .split(";").map((h) => h.trim().toLowerCase()).filter(Boolean);
// Rutas sin clave: la app vieja tiene que poder actualizarse, y la nueva vincularse.
const OPEN_PATHS = new Set(["/api/app-version", "/download/app.apk", "/api/pair"]);
const MAX_PAIR_TRIES = 5;

// Clave de la app: se crea una vez y queda en app-key.txt (borrarlo desvincula todo).
function loadAppKey() {
  try {
    const k = readFileSync(APP_KEY_PATH, "utf8").trim();
    if (k.length >= 32) return k;
  } catch { /* se crea abajo */ }
  const k = randomBytes(32).toString("hex");
  writeFileSync(APP_KEY_PATH, k + "\n", { mode: 0o600 });
  return k;
}
const appKey = loadAppKey();

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

export function keyOk(req) {
  if (!APP_ONLY) return true;
  const k = req.headers["x-cr-key"] || cookie(req.headers.cookie, "cr_key");
  return !!k && safeEqual(k, appKey);
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
  console.log(`[vinculación] dispositivo vinculado: ${String(req.body?.name || "?").slice(0, 60)}`);
  res.json({ key: appKey });
}
