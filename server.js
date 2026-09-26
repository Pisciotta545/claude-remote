import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { spawn } from "node-pty";
import { spawn as spawnChild } from "child_process";
import { readFile, readdir, stat, mkdir, writeFile, rename, realpath } from "fs/promises";
import { createReadStream, createWriteStream, watch, existsSync, readFileSync, writeFileSync } from "fs";
import { createServer as createNetServer } from "net";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { createInterface } from "readline";
import { createHash, randomBytes } from "crypto";
import { homedir, tmpdir } from "os";
import { join, dirname, resolve, sep, basename, relative, isAbsolute } from "path";
import { fileURLToPath } from "url";
import { pushEnabled, pushCredential, addToken, removeToken, sendPush } from "./push.js";
import { guard, wsAllowed, pairHandler, deviceActive, APP_ONLY } from "./security.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Puerto propio de cada PC: PORT > config.json > 3000 en un clon de git (el
// celular del autor ya apunta ahí) > uno libre al azar (20000–29999) la primera
// vez en una instalación, guardado en config.json. Así no choca con el 3000 de
// otros proyectos. El estado del Tailscale integrado usa PORT+99.
const CONFIG_PATH = join(__dirname, "config.json");
function readConfig() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; }
}
const portFree = (port) => new Promise((res) => {
  const s = createNetServer().once("error", () => res(false));
  s.once("listening", () => s.close(() => res(true))).listen(port, "127.0.0.1");
});
async function choosePort() {
  if (process.env.PORT) return Number(process.env.PORT);
  const cfg = readConfig();
  if (cfg.port) return Number(cfg.port);
  if (existsSync(join(__dirname, ".git"))) return 3000;
  for (let i = 0; i < 50; i++) {
    const p = 20000 + Math.floor(Math.random() * 10000);
    if ((await portFree(p)) && (await portFree(p + 99))) {
      writeFileSync(CONFIG_PATH, JSON.stringify({ ...cfg, port: p }, null, 2) + "\n");
      return p;
    }
  }
  return 3000;
}
const PORT = await choosePort();
// Solo local por defecto: desde afuera se entra por el nodo de Tailscale
// (claude-remote-ts), que reenvía a 127.0.0.1. HOST=0.0.0.0 abre la red local.
const HOST = process.env.HOST || "127.0.0.1";
const SHELL = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "bash");
const CLAUDE_CMD = process.env.CLAUDE_CMD || "claude --dangerously-skip-permissions";
const START_DIR = process.env.CLAUDE_CWD || homedir();
// Raíces donde buscar proyectos. Por defecto, la carpeta que contiene este repo
// si se corre desde un clon de git; instalado (sin .git) no hay raíces: solo se
// listan las carpetas que Claude ya conoce (ver listKnownProjectPaths).
const PROJECTS_ROOTS = (process.env.PROJECTS_DIRS ?? (existsSync(join(__dirname, ".git")) ? dirname(__dirname) : ""))
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => resolve(s));
const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
// Carpetas donde ya usaste Claude (le "diste permiso"): su ruta real vive en las
// sesiones y en ~/.claude.json (las que aceptaste en "¿Confiás en esta carpeta?").
const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const CLAUDE_CONFIG_PATH = join(homedir(), ".claude.json");
// Profundidad máxima al buscar proyectos anidados dentro de las raíces.
const MAX_DEPTH = Math.max(1, parseInt(process.env.PROJECTS_DEPTH || "3", 10));
// Un subdirectorio con alguno de estos archivos se considera un proyecto en sí.
const PROJECT_MARKERS = [
  ".git", ".claude", "package.json", "pubspec.yaml", "pom.xml",
  "build.gradle", "Cargo.toml", "requirements.txt", "go.mod", ".csproj",
];
// Carpetas que nunca vale la pena recorrer.
const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".dart_tool", "build", "dist", ".gradle",
  ".idea", ".vscode", "vendor", "__pycache__", ".venv", "venv", "obj", "bin",
]);
// Autoactualización del APK.
const APK_PATH = process.env.APK_PATH || join(__dirname, "claude-remote.apk");
const APP_VERSION_PATH = join(__dirname, "app-version.json");
// Persistencia de sesión: el proceso Claude sigue vivo entre reconexiones y se
// guarda un buffer de su salida para re-dibujar la pantalla al reconectar.
const SESSION_BUFFER_BYTES = Math.max(16_384, parseInt(process.env.SESSION_BUFFER_BYTES || "200000", 10));
// Cuánto se mantiene vivo el proceso sin clientes conectados. Por defecto 0 =
// NUNCA se apaga solo: sigue trabajando en segundo plano (aunque bloquees el
// celular o cambies de app) hasta que pulses "Cerrar". Poné un valor en ms para
// forzar un apagado por inactividad.
const SESSION_IDLE_MS = Math.max(0, parseInt(process.env.SESSION_IDLE_MS || "0", 10));
// Archivos que se adjuntan desde el celular (imágenes, etc.) para pasárselos a Claude.
const UPLOAD_DIR = process.env.UPLOAD_DIR || join(tmpdir(), "claude-remote-uploads");
// Tamaño máximo que se abre en el editor de archivos de la app.
const EDITOR_MAX_BYTES = Math.max(65_536, parseInt(process.env.EDITOR_MAX_BYTES || "2000000", 10));
// Extensiones de build que se ofrecen para descargar al celular cuando aparecen
// (o se reescriben) dentro de la carpeta de una sesión. Vacío = desactivado.
const BUILD_EXTS = (process.env.BUILD_EXTS ?? ".apk")
  .split(";").map((e) => e.trim().toLowerCase()).filter(Boolean);
// Tailscale integrado de la PC (tailnet-host/): pone este servidor en la tailnet
// sin la app de Tailscale. Se lanza solo si existe el binario; TAILNET=0 lo apaga.
const TAILNET_BIN = process.env.TAILNET_BIN ||
  join(__dirname, process.platform === "win32" ? "claude-remote-ts.exe" : "claude-remote-ts");
const TAILNET_STATUS = process.env.TAILNET_STATUS || `127.0.0.1:${PORT + 99}`;
// Repo de GitHub cuyas releases se ofrecen para descargar desde la app y de
// donde sale la actualización de la app (APP_UPDATES=local: solo el APK local).
const RELEASES_REPO = process.env.RELEASES_REPO || "Pisciotta545/claude-remote";
const APP_UPDATES_GITHUB = process.env.APP_UPDATES !== "local";
const UPDATES_DIR = join(__dirname, "updates");

// Argumentos según el shell REAL, no según el SO (evita mezclar estilos).
function shellArgs(shell, cmd) {
  const name = shell.toLowerCase();
  if (name.includes("powershell") || name.includes("pwsh")) return ["-NoLogo", "-Command", cmd];
  if (name.includes("cmd")) return ["/c", cmd];
  return ["-lc", cmd]; // bash/zsh/sh y demás POSIX
}

// Entorno del PTY sin las marcas de "sesión de Claude" que se heredan si el
// servidor se lanzó desde dentro de Claude Code: con ellas, cada claude de la
// app se cree subsesión y no guarda la conversación ("Transcript saving is off").
// También las que Claude Code pone en su shell: NO_COLOR=1 dejaba la terminal de
// la app sin colores (sin el resaltado de tus mensajes).
const CLAUDE_SESSION_VARS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|SESSION_ATTENDED|ENTRYPOINT|MESSAGING_\w+|SSE_PORT)|NO_COLOR|GIT_TERMINAL_PROMPT)$/;
function ptyEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !CLAUDE_SESSION_VARS.test(k)));
}

// Normaliza rutas para comparar sin sorpresas de mayúsculas (Windows).
const norm = (p) => resolve(p).toLowerCase();

// Solo permite iniciar Claude dentro de una raíz configurada o en una carpeta
// que ya conozca Claude (a la que "le diste permiso").
async function isAllowed(p) {
  if (!p) return false;
  const rp = resolve(p);
  const inRoots = PROJECTS_ROOTS.some(
    (root) => norm(rp) === norm(root) || norm(rp).startsWith(norm(root) + sep)
  );
  if (inRoots) return true;
  const known = await listKnownProjectPaths();
  return known.some((k) => norm(k) === norm(rp));
}

// Devuelve el primer `cwd` que aparezca en un .jsonl de sesión (lee en streaming
// y corta apenas lo encuentra, para no cargar archivos grandes enteros).
function firstCwd(jsonlPath) {
  return new Promise((res) => {
    let done = false;
    const finish = (v) => {
      if (!done) { done = true; res(v); }
    };
    const rl = createInterface({
      input: createReadStream(jsonlPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      if (done || !line.trim()) return;
      try {
        const o = JSON.parse(line);
        if (o.cwd) { finish(o.cwd); rl.close(); }
      } catch { /* línea no-JSON: ignora */ }
    });
    rl.on("close", () => finish(null));
    rl.on("error", () => finish(null));
  });
}

// Carpetas marcadas como confiables en ~/.claude.json (`projects[ruta].hasTrustDialogAccepted`).
async function trustedProjectPaths() {
  try {
    const projects = JSON.parse(await readFile(CLAUDE_CONFIG_PATH, "utf8")).projects || {};
    return Object.entries(projects).filter(([, v]) => v?.hasTrustDialogAccepted).map(([k]) => resolve(k));
  } catch { return []; }
}

// Rutas reales de todas las carpetas donde ya se usó Claude, con caché corto.
let _knownCache = { at: 0, paths: [] };
async function listKnownProjectPaths() {
  if (Date.now() - _knownCache.at < 10_000) return _knownCache.paths;
  const out = await trustedProjectPaths();
  let dirs;
  try {
    dirs = await readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
  } catch {
    _knownCache = { at: Date.now(), paths: out };
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const projDir = join(CLAUDE_PROJECTS_DIR, d.name);
    let files;
    try {
      files = (await readdir(projDir)).filter((f) => f.endsWith(".jsonl"));
    } catch { continue; }
    for (const f of files) {
      const cwd = await firstCwd(join(projDir, f));
      if (cwd) { out.push(cwd); break; }
    }
  }
  _knownCache = { at: Date.now(), paths: out };
  return out;
}

// ¿El directorio contiene algún marcador que lo identifique como proyecto?
async function hasMarker(dir) {
  for (const m of PROJECT_MARKERS) {
    try { await stat(join(dir, m)); return true; } catch { /* sigue */ }
  }
  return false;
}

// Recorre las raíces: nivel 1 siempre; niveles más profundos solo si el
// subdirectorio parece un proyecto (marcador). No entra en proyectos ya hallados.
async function scanRoots() {
  const out = [];
  async function walk(dir, depth) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || IGNORE_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      const marker = await hasMarker(full);
      if (depth === 1 || marker) out.push(full);
      if (depth < MAX_DEPTH && !marker) await walk(full, depth + 1);
    }
  }
  for (const root of PROJECTS_ROOTS) await walk(root, 1);
  return out;
}
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
// Última respuesta de uso buena, para servirla si Anthropic responde 429 (rate
// limit) y no dejar el panel en blanco ni con datos que parezcan agotados.
let usageCache = null; // { payload, at }

const app = express();
const server = createServer(app);

// Red superior: un error de socket transitorio (p. ej. al cambiar de Wi-Fi)
// no debe tumbar el proceso. Se registra y se sigue sirviendo.
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
// Puerto ocupado: sale con 98 para que el tray avise y no lo relance en bucle.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`El puerto ${PORT} está ocupado por otro programa (tray → "Cambiar puerto…").`);
    process.exit(98);
  }
  console.error("[http error]", err);
});

// Seguridad (security.js): Host/Origin propios y clave de la app en cada pedido.
app.use(guard);
app.use(express.json());
app.post("/api/pair", pairHandler); // vinculación de la app con el código de la PC
app.get("/api/auth", (_req, res) => res.json({ ok: true })); // la app verifica su clave
// Sin caché para la app: el WebView de Android reusaba HTML/JS viejo tras
// actualizar. Con no-store siempre baja la última versión.
// Solo corre código servido por esta PC (sin CDNs): aunque un tercero inyectara
// un <script> externo, el WebView no lo ejecuta ni puede mandar datos afuera.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'self'",
  "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
].join("; ");
app.use((_req, res, next) => {
  if (!res.getHeader("Content-Security-Policy")) res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.use(express.static(join(__dirname, "public"), {
  setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
}));
// Librerías de la web desde node_modules (versiones fijas en package-lock).
for (const [route, dir] of [
  ["/vendor/xterm", "node_modules/@xterm/xterm"],
  ["/vendor/addon-fit", "node_modules/@xterm/addon-fit/lib"],
  ["/vendor/codemirror", "node_modules/codemirror"],
]) app.use(route, express.static(join(__dirname, dir), { maxAge: "7d" }));

// --- Métricas de uso -------------------------------------------------------
async function readAccessToken() {
  const raw = await readFile(CREDENTIALS_PATH, "utf8");
  const creds = JSON.parse(raw);
  const token =
    creds?.claudeAiOauth?.accessToken ||
    creds?.accessToken ||
    creds?.access_token;
  if (!token) throw new Error("No se encontró accessToken en las credenciales");
  return token;
}

app.get("/api/usage", async (_req, res) => {
  try {
    const token = await readAccessToken();
    const upstream = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
    });

    if (!upstream.ok) {
      // Rate limit u otro error: reusa el último dato bueno si lo hay (marcado
      // como "stale") en vez de devolver un error que vacíe/congele el panel.
      if (usageCache) {
        return res.json({ ...usageCache.payload, stale: true, cachedAt: usageCache.at });
      }
      return res
        .status(upstream.status)
        .json({ error: `API respondió ${upstream.status}` });
    }

    const data = await upstream.json();
    // Solo las ventanas con datos reales (utilization y resets_at presentes);
    // descarta las vacías/placeholder (nimbus_quill, extra_usage, etc.).
    const windows = {};
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && v.utilization != null && v.resets_at != null) {
        windows[k] = { utilization: v.utilization, resets_at: v.resets_at };
      }
    }
    const payload = {
      utilization: data.utilization ?? data.five_hour?.utilization ?? null,
      resets_at: data.resets_at ?? data.five_hour?.resets_at ?? null,
      windows,
      raw: data,
    };
    usageCache = { payload, at: Date.now() };
    res.json(payload);
  } catch (err) {
    if (usageCache) return res.json({ ...usageCache.payload, stale: true, cachedAt: usageCache.at });
    res.status(500).json({ error: err.message });
  }
});

// --- Autoactualización del APK ---------------------------------------------
// --- Releases de GitHub -----------------------------------------------------
// Caché de 10 min: sin token, la API de GitHub permite 60 consultas por hora;
// ante un error se usa la última lista buena (`stale`).
let ghCache = { at: 0, list: null };
async function githubReleases() {
  if (ghCache.list && Date.now() - ghCache.at < 600_000) return { list: ghCache.list, stale: false };
  try {
    const r = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=10`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "claude-remote" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`GitHub respondió ${r.status}`);
    ghCache = { at: Date.now(), list: (await r.json()).filter((x) => !x.draft) };
    return { list: ghCache.list, stale: false };
  } catch (err) {
    if (ghCache.list) return { list: ghCache.list, stale: true };
    throw err;
  }
}

// Botón "📦 Releases": las 2 últimas con sus archivos.
app.get("/api/releases", async (_req, res) => {
  try {
    const { list, stale } = await githubReleases();
    const releases = list.slice(0, 2).map((x) => ({
      tag: x.tag_name,
      name: x.name || x.tag_name,
      date: x.published_at,
      url: x.html_url,
      notes: String(x.body || "").slice(0, 3000),
      assets: (x.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url })),
    }));
    res.json({ repo: RELEASES_REPO, releases, ...(stale ? { stale } : {}) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Actualización de la app ------------------------------------------------
// Fuentes: la local (app-version.json + claude-remote.apk) y la última release
// de GitHub que traiga un .apk y un app-version.json ({versionCode, versionName}).
// Gana el versionCode más alto. Si gana GitHub, /download/app.apk la baja una vez
// a updates/ y la sirve: la app sigue bajando por el servidor (por la tailnet y
// sin mandarle su clave a GitHub), así que funciona igual con apps viejas.
let ghAppCache = { tag: null, info: null };
async function githubApp() {
  const { list } = await githubReleases();
  for (const rel of list) {
    if (rel.prerelease) continue;
    const meta = rel.assets.find((a) => a.name === "app-version.json");
    const apk = rel.assets.find((a) => a.name.toLowerCase().endsWith(".apk"));
    if (!meta || !apk) continue;
    if (ghAppCache.tag !== rel.tag_name) {
      const r = await fetch(meta.browser_download_url, {
        headers: { "User-Agent": "claude-remote" }, signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`app-version.json de ${rel.tag_name}: ${r.status}`);
      const info = await r.json();
      ghAppCache = {
        tag: rel.tag_name,
        info: {
          versionCode: Number(info.versionCode), versionName: String(info.versionName),
          apk: { name: basename(apk.name), size: apk.size, url: apk.browser_download_url },
        },
      };
    }
    return ghAppCache.info;
  }
  return null;
}

async function latestApp() {
  let local = null;
  try {
    const info = JSON.parse(await readFile(APP_VERSION_PATH, "utf8"));
    if (existsSync(APK_PATH)) local = { versionCode: info.versionCode, versionName: info.versionName, source: "local" };
  } catch { /* sin versión local */ }
  let remote = null;
  if (APP_UPDATES_GITHUB) {
    try { remote = await githubApp(); } catch (err) { console.error("[update] GitHub:", err.message); }
  }
  if (remote && (!local || remote.versionCode > local.versionCode)) return { ...remote, source: "github" };
  return local;
}

// Baja (una sola vez, aunque lleguen varios pedidos juntos) el APK de GitHub.
const apkDownloads = new Map();
function githubApk({ name, size, url }) {
  const file = join(UPDATES_DIR, name);
  if (!apkDownloads.has(file)) {
    apkDownloads.set(file, (async () => {
      if ((await stat(file).catch(() => null))?.size === size) return file;
      await mkdir(UPDATES_DIR, { recursive: true });
      const r = await fetch(url, { headers: { "User-Agent": "claude-remote" }, signal: AbortSignal.timeout(300_000) });
      if (!r.ok) throw new Error(`descarga ${r.status}`);
      const tmp = file + ".part";
      await pipeline(Readable.fromWeb(r.body), createWriteStream(tmp));
      if ((await stat(tmp)).size !== size) throw new Error("descarga incompleta");
      await rename(tmp, file);
      return file;
    })().finally(() => apkDownloads.delete(file)));
  }
  return apkDownloads.get(file);
}

app.get("/api/app-version", async (_req, res) => {
  const latest = await latestApp();
  if (!latest) return res.status(404).json({ error: "sin versión de la app" });
  res.json({ versionCode: latest.versionCode, versionName: latest.versionName, source: latest.source, url: "/download/app.apk" });
});

app.get("/download/app.apk", async (_req, res) => {
  const latest = await latestApp();
  if (latest?.source === "github") {
    try {
      return res.download(await githubApk(latest.apk), latest.apk.name);
    } catch (err) {
      console.error("[update] no se pudo bajar de GitHub:", err.message); // cae al APK local
    }
  }
  res.download(APK_PATH, "claude-remote.apk", (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "APK no disponible" });
  });
});

// --- Builds detectados (descarga al celular) --------------------------------
// Solo se sirven archivos registrados por el vigilante de builds (id aleatorio),
// nunca una ruta arbitraria del disco.
const builds = new Map(); // id → { path, name }
app.get("/api/builds/:id", (req, res) => {
  const b = builds.get(req.params.id);
  if (!b) return res.status(404).json({ error: "build no disponible" });
  res.download(b.path, b.name, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "build no disponible" });
  });
});

// --- Adjuntar archivos desde el celular ------------------------------------
// El cliente manda el archivo crudo (application/octet-stream) y recibe la ruta
// donde quedó; esa ruta se escribe en el prompt para que Claude lo lea.
app.post("/api/upload", express.raw({ type: () => true, limit: "50mb" }), async (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "archivo vacío" });
    const name = basename(String(req.query.name || "archivo")).replace(/[^\w.\-]+/g, "_").slice(-80) || "archivo";
    await mkdir(UPLOAD_DIR, { recursive: true });
    const file = join(UPLOAD_DIR, `${Date.now()}-${name}`);
    await writeFile(file, req.body);
    res.json({ path: file });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Explorador / editor de archivos ---------------------------------------
// Todo relativo a la carpeta del proyecto (`cwd`, que debe estar permitida);
// nunca deja salir de ella con "..".
const inside = (root, p) => {
  const r = relative(root, p);
  return !r.startsWith("..") && !isAbsolute(r); // ni escapa ni es otra unidad
};
async function projectPath(cwd, rel = "") {
  if (!cwd || !(await isAllowed(cwd))) return null;
  const root = resolve(cwd);
  const full = resolve(root, String(rel));
  if (!inside(root, full)) return null;
  // Accesos directos (symlinks/junctions): el destino real también debe quedar
  // adentro. Un archivo nuevo se valida por su carpeta.
  try {
    const realRoot = await realpath(root);
    const real = await realpath(full).catch(async () => join(await realpath(dirname(full)), basename(full)));
    return inside(realRoot, real) ? full : null;
  } catch { return null; }
}

app.get("/api/files", async (req, res) => {
  const dir = await projectPath(req.query.cwd, req.query.dir);
  if (!dir) return res.status(403).json({ error: "ruta no permitida" });
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const out = await Promise.all(entries.map(async (e) => {
      if (e.isDirectory()) return { name: e.name, dir: true, size: 0 };
      const st = await stat(join(dir, e.name)).catch(() => null); // sigue symlinks
      return { name: e.name, dir: !!st?.isDirectory(), size: st?.isFile() ? st.size : 0 };
    }));
    out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
    res.json({ entries: out });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Texto: {content, mtime, size}; binario o muy grande: {binary|tooBig, size}.
// `raw=1` sirve el archivo tal cual (vista previa de imágenes).
app.get("/api/file", async (req, res) => {
  const file = await projectPath(req.query.cwd, req.query.path);
  if (!file) return res.status(403).json({ error: "ruta no permitida" });
  try {
    const st = await stat(file);
    if (!st.isFile()) return res.status(400).json({ error: "no es un archivo" });
    if (req.query.raw) {
      // Vista previa: el contenido del proyecto no es de confianza, que nunca corra.
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
      return res.sendFile(file, { dotfiles: "allow" });
    }
    const info = { size: st.size, mtime: st.mtimeMs };
    if (st.size > EDITOR_MAX_BYTES) return res.json({ ...info, tooBig: true });
    const buf = await readFile(file);
    if (buf.subarray(0, 8000).includes(0)) return res.json({ ...info, binary: true });
    res.json({ ...info, content: buf.toString("utf8") });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Guarda. Si el archivo cambió desde que se abrió (`mtime` distinto, p. ej. lo
// editó Claude) responde 409, salvo `force=1`.
// Cuerpo crudo: se escriben los bytes tal cual (express.text quitaría el BOM).
app.put("/api/file", express.raw({ type: () => true, limit: "10mb" }), async (req, res) => {
  const file = await projectPath(req.query.cwd, req.query.path);
  if (!file) return res.status(403).json({ error: "ruta no permitida" });
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: "cuerpo inválido" });
  try {
    const cur = await stat(file).catch(() => null);
    if (cur && !req.query.force && req.query.mtime && Math.abs(cur.mtimeMs - Number(req.query.mtime)) > 1)
      return res.status(409).json({ error: "el archivo cambió en la PC", mtime: cur.mtimeMs });
    await writeFile(file, req.body);
    res.json({ mtime: (await stat(file)).mtimeMs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Comandos personalizados y skills (menú "/" de la app) ------------------
// Lee name/description del frontmatter de un .md.
async function mdMeta(file) {
  try {
    const head = (await readFile(file, "utf8")).slice(0, 4000);
    const fm = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const get = (k) => {
      const m = fm && fm[1].match(new RegExp(`^${k}:\\s*(.*)$`, "m"));
      return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
    };
    return { name: get("name"), description: get("description") };
  } catch { return { name: "", description: "" }; }
}

// Busca archivos que cumplan `test` hasta cierta profundidad.
async function findFiles(dir, test, depth = 3) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory() && depth > 1) out.push(...(await findFiles(full, test, depth - 1)));
    else if (e.isFile() && test(e.name)) out.push(full);
  }
  return out;
}

app.get("/api/commands", async (req, res) => {
  const cwd = req.query.cwd;
  const bases = [[join(homedir(), ".claude"), "usuario"]];
  if (cwd && (await isAllowed(cwd))) bases.unshift([join(cwd, ".claude"), "proyecto"]);
  const seen = new Set();
  const commands = [];
  for (const [base, scope] of bases) {
    for (const f of await findFiles(join(base, "commands"), (n) => n.endsWith(".md"))) {
      const name = basename(f, ".md");
      if (seen.has(name)) continue;
      seen.add(name);
      commands.push({ cmd: "/" + name, desc: (await mdMeta(f)).description, scope });
    }
    for (const f of await findFiles(join(base, "skills"), (n) => n === "SKILL.md", 4)) {
      const meta = await mdMeta(f);
      const name = meta.name || basename(dirname(f));
      if (seen.has(name)) continue;
      seen.add(name);
      commands.push({ cmd: "/" + name, desc: meta.description, scope: `skill · ${scope}` });
    }
  }
  res.json({ commands });
});

// --- Tailscale integrado de la PC -------------------------------------------
// Estado del nodo ({state, authURL, ip, name}) o null si no corre.
async function tailnetStatus() {
  try {
    const r = await fetch(`http://${TAILNET_STATUS}/status`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// Lo mantiene corriendo. Si ya hay uno (p. ej. lanzado a mano) no lanza otro;
// con -watch-stdin se cierra solo cuando este proceso termina.
let tailnetChild = null;
let tailnetAuthLogged = "";
async function superviseTailnet() {
  if (process.env.TAILNET === "0") return;
  try { await stat(TAILNET_BIN); } catch { return; } // no compilado: nada que hacer
  const st = await tailnetStatus();
  if (st?.state === "NeedsLogin" && st.authURL && st.authURL !== tailnetAuthLogged) {
    tailnetAuthLogged = st.authURL;
    console.log(`Tailscale integrado: iniciá sesión en ${st.authURL}`);
  }
  if (st || tailnetChild) return;
  tailnetChild = spawnChild(TAILNET_BIN, [
    "-watch-stdin", "-port", String(PORT), "-target", `127.0.0.1:${PORT}`,
    "-status", TAILNET_STATUS, "-dir", join(__dirname, "tailscale-state"),
    "-logfile", join(__dirname, "tailscale-state", "tailnet.log"),
  ], { stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
  tailnetChild.on("exit", () => { tailnetChild = null; });
  tailnetChild.on("error", (err) => { console.error("[tailnet]", err.message); tailnetChild = null; });
}

app.get("/api/tailnet", async (_req, res) => {
  res.json((await tailnetStatus()) || { state: "off" });
});

// --- Listado de proyectos --------------------------------------------------
app.get("/api/projects", async (_req, res) => {
  try {
    // Fuente 1+2: subcarpetas de las raíces (nivel 1 + proyectos anidados).
    // Fuente 3: carpetas donde ya usaste Claude ("con permiso"), aunque estén
    // fuera de las raíces o en otra unidad.
    const [scanned, known] = await Promise.all([scanRoots(), listKnownProjectPaths()]);

    // Deduplica por ruta y conserva solo carpetas que existan.
    const seen = new Map();
    for (const p of [...scanned, ...known]) {
      const key = norm(p);
      if (seen.has(key)) continue;
      try {
        if (!(await stat(p)).isDirectory()) continue;
      } catch { continue; }
      seen.set(key, p);
    }

    // Nombre a mostrar; desambigua duplicados anteponiendo la carpeta padre.
    const counts = new Map();
    const paths = [...seen.values()];
    for (const p of paths) {
      const b = basename(p).toLowerCase();
      counts.set(b, (counts.get(b) || 0) + 1);
    }
    const out = paths.map((p) => {
      const b = basename(p);
      const name = counts.get(b.toLowerCase()) > 1
        ? `${basename(dirname(p))}${sep}${b}`
        : b;
      return { name, path: p };
    });

    out.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ projects: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Terminal PTY vía WebSocket -------------------------------------------
const wss = new WebSocketServer({ server, path: "/ws", verifyClient: ({ req }) => wsAllowed(req) });

// Sesiones vivas, una por carpeta (clave = ruta normalizada). Sobreviven a la
// desconexión del WebSocket para que reconectar no reinicie la conversación.
const sessions = new Map();

// Agrega salida al buffer y recorta el historial más viejo si supera el tope.
function pushBuffer(s, data) {
  s.buffer.push(data);
  s.bytes += Buffer.byteLength(data);
  while (s.bytes > SESSION_BUFFER_BYTES && s.buffer.length > 1) {
    s.bytes -= Buffer.byteLength(s.buffer.shift());
  }
}

function broadcast(s, obj) {
  const frame = JSON.stringify(obj);
  for (const c of s.clients) if (c.readyState === c.OPEN) c.send(frame);
}

// Detiene la sesión de una carpeta (botón "Cerrar"). El onExit del PTY se
// encarga del broadcast de salida y de borrarla del mapa.
function stopSession(key) {
  const s = sessions.get(key);
  if (!s) return false;
  s.stopping = true; // el cierre es a propósito: no notificar por su campana
  if (s.killTimer) { clearTimeout(s.killTimer); s.killTimer = null; }
  try { s.pty.kill(); } catch { /* ya había terminado */ }
  return true;
}

// --- Sesiones en segundo plano (verlas y cerrarlas desde el selector) -------
app.get("/api/sessions", (_req, res) => {
  const list = [...sessions.values()].map((s) => ({ path: s.cwd, clients: s.clients.size }));
  res.json({ sessions: list });
});
app.post("/api/sessions/stop", (req, res) => {
  const path = req.body?.path;
  if (!path) return res.status(400).json({ error: "falta 'path'" });
  res.json({ stopped: stopSession(norm(path)) });
});

// --- Notificaciones push (registro de dispositivos) ------------------------
app.post("/api/push/register", (req, res) => {
  const token = req.body?.token;
  if (!token) return res.status(400).json({ error: "falta 'token'" });
  addToken(token);
  res.json({ ok: true, enabled: pushEnabled() });
});
app.post("/api/push/unregister", (req, res) => {
  removeToken(req.body?.token);
  res.json({ ok: true });
});

// Avisa cuando Claude emite la campana (BEL) —terminó o espera tu respuesta—,
// pero solo si NO lo estás mirando (sesión sin clientes) y con antirrebote.
const BELL_DEBOUNCE_MS = 4000;
// La notificación pasa por Google: en vez de la ruta viaja un id opaco que la
// app canjea por la carpeta (GET /api/push/target) al tocarla.
const pushTargets = new Map(); // id → carpeta
function pushTarget(cwd) {
  for (const [id, p] of pushTargets) if (p === cwd) return `cr:${id}`;
  const id = randomBytes(9).toString("hex");
  pushTargets.set(id, cwd);
  return `cr:${id}`;
}
app.get("/api/push/target", (req, res) => {
  const p = pushTargets.get(String(req.query.id || "").replace(/^cr:/, ""));
  p ? res.json({ path: p }) : res.status(404).json({ error: "notificación vencida" });
});

function maybeNotify(s) {
  if (!pushEnabled() || s.clients.size > 0 || s.stopping) return;
  const now = Date.now();
  if (now - (s.lastBell || 0) < BELL_DEBOUNCE_MS) return;
  s.lastBell = now;
  sendPush({
    title: "Claude te necesita",
    body: `${basename(s.cwd)} · esperando tu respuesta`,
    data: { path: pushTarget(s.cwd) },
  });
}

// --- Vigilante de builds ----------------------------------------------------
// Observa (recursivo) la carpeta de cada sesión. Cuando aparece o se reescribe
// un archivo con extensión de BUILD_EXTS, espera a que termine de escribirse y
// ofrece descargarlo al celular (WS "build" y, si nadie mira, push).
const BUILD_SETTLE_MS = 3000;
const BUILD_IGNORE = /[\\/](node_modules|intermediates|tmp|\.git)[\\/]/i;
const MAX_BUILDS = 30;

function hashFile(file) {
  return new Promise((res) => {
    const h = createHash("sha1");
    createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => res(h.digest("hex")))
      .on("error", () => res(null));
  });
}

function watchBuilds(s) {
  if (!BUILD_EXTS.length) return;
  const changed = new Set();
  let timer = null;

  async function flush() {
    timer = null;
    const files = [...changed];
    changed.clear();
    const found = new Map(); // hash → build (una sola entrada por copias idénticas)
    for (const file of files) {
      let st;
      try { st = await stat(file); } catch { continue; } // se borró
      if (!st.isFile() || !st.size) continue;
      if (Date.now() - st.mtimeMs < 1500) { // todavía se está escribiendo
        changed.add(file);
        continue;
      }
      const hash = (await hashFile(file)) || file;
      const rel = relative(s.cwd, file);
      const prev = found.get(hash);
      if (prev && prev.rel.length <= rel.length) continue;
      found.set(hash, { file, rel, size: st.size });
    }
    if (changed.size) timer = setTimeout(flush, BUILD_SETTLE_MS);
    if (found.size && !s.stopping) notifyBuild(s, [...found.values()]);
  }

  try {
    s.watcher = watch(s.cwd, { recursive: true }, (_ev, name) => {
      if (!name) return;
      const f = String(name);
      if (!BUILD_EXTS.some((e) => f.toLowerCase().endsWith(e))) return;
      if (BUILD_IGNORE.test(sep + f)) return;
      changed.add(join(s.cwd, f));
      clearTimeout(timer);
      timer = setTimeout(flush, BUILD_SETTLE_MS);
    });
    s.watcher.on("error", () => { /* carpeta borrada o sin permisos: sin avisos */ });
  } catch { /* sin watch recursivo en esta plataforma */ }
}

function notifyBuild(s, found) {
  const list = found.map(({ file, rel, size }) => {
    const id = randomBytes(8).toString("hex");
    builds.set(id, { path: file, name: basename(file) });
    if (builds.size > MAX_BUILDS) builds.delete(builds.keys().next().value);
    return { id, name: basename(file), rel, size, url: `/api/builds/${id}` };
  });
  s.pendingBuild = list; // se reenvía al reconectar hasta que alguien responda
  broadcast(s, { type: "build", builds: list });
  if (pushEnabled() && s.clients.size === 0) {
    sendPush({
      title: "Build listo 📦",
      body: `${basename(s.cwd)} · ${list[0].name} — tocá para descargarlo`,
      data: { path: pushTarget(s.cwd) },
    });
  }
}

// Cada 5 s: corta los WebSocket de celulares desvinculados (bandeja o `npm run devices`).
setInterval(() => {
  for (const ws of wss.clients) if (!deviceActive(ws.crDevice)) ws.terminate();
}, 5000).unref();

wss.on("connection", (ws, req) => {
  ws.crDevice = req.crDevice;
  let session = null;
  let key = null;

  async function attach(cwd, fresh, cols, rows) {
    if (session) return; // este socket ya está adjunto a una sesión
    const dir = (await isAllowed(cwd)) ? cwd : START_DIR;
    key = norm(dir);

    let s = sessions.get(key);
    if (!s) {
      // No hay proceso vivo para esta carpeta: se crea uno.
      // Si ya existe historial de Claude aquí y no se pidió empezar de cero,
      // se reanuda la conversación anterior con --continue.
      const known = await listKnownProjectPaths();
      const resume =
        !fresh &&
        CLAUDE_CMD.includes("claude") &&
        known.some((k) => norm(k) === key);
      const cmd = resume ? `${CLAUDE_CMD} --continue` : CLAUDE_CMD;

      let pty;
      try {
        pty = spawn(SHELL, shellArgs(SHELL, cmd), {
          name: "xterm-color",
          // Arranca con el tamaño real del cliente (si lo mandó en el "start"),
          // así Claude no dibuja primero a 80 cols y luego se reajusta, lo que
          // dejaba el buffer descuadrado y persistía hasta recargar.
          cols: cols > 0 ? cols : 80,
          rows: rows > 0 ? rows : 24,
          cwd: dir,
          env: ptyEnv(),
        });
      } catch (err) {
        if (ws.readyState === ws.OPEN)
          ws.send(JSON.stringify({ type: "output", data: `\r\n[error al iniciar: ${err.message}]\r\n` }));
        return;
      }

      s = { pty, cwd: dir, buffer: [], bytes: 0, clients: new Set(), killTimer: null };
      sessions.set(key, s);
      watchBuilds(s);

      pty.onData((data) => {
        pushBuffer(s, data);
        broadcast(s, { type: "output", data });
        if (data.includes("\x07")) maybeNotify(s); // campana → aviso push
      });

      pty.onExit(({ exitCode }) => {
        if (s.killTimer) clearTimeout(s.killTimer);
        try { s.watcher?.close(); } catch { /* ya cerrado */ }
        broadcast(s, { type: "exit", code: exitCode });
        sessions.delete(key);
      });
    }

    // Adjunta este socket y cancela el apagado por inactividad.
    if (s.killTimer) { clearTimeout(s.killTimer); s.killTimer = null; }
    s.clients.add(ws);
    session = s;

    // Re-dibuja en el cliente lo que ya había en pantalla.
    if (s.buffer.length && ws.readyState === ws.OPEN)
      ws.send(JSON.stringify({ type: "restore", data: s.buffer.join("") }));
    // Build detectado mientras no mirabas: se vuelve a ofrecer hasta que respondas.
    if (s.pendingBuild && ws.readyState === ws.OPEN)
      ws.send(JSON.stringify({ type: "build", builds: s.pendingBuild }));
  }

  ws.on("message", (msg) => {
    try {
      const { type, data, cols, rows, cwd, fresh } = JSON.parse(msg.toString());
      if (type === "start") attach(cwd, fresh, cols, rows);
      else if (type === "input" && session?.pty) session.pty.write(data);
      else if (type === "resize" && session?.pty) session.pty.resize(cols, rows);
      else if (type === "stop" && key) stopSession(key); // "Cerrar": detiene el proceso
      else if (type === "build-ack" && session) session.pendingBuild = null; // ya respondiste
    } catch {
      /* ignora frames malformados */
    }
  });

  ws.on("close", () => {
    if (!session) return;
    session.clients.delete(ws);
    // Sin clientes el proceso sigue vivo en segundo plano. Solo se programa un
    // apagado si SESSION_IDLE_MS > 0; con 0 (def.) vive hasta pulsar "Cerrar".
    if (session.clients.size === 0 && SESSION_IDLE_MS > 0) {
      const s = session, k = key;
      s.killTimer = setTimeout(() => {
        try { s.pty.kill(); } catch { /* ya terminó */ }
        sessions.delete(k);
      }, SESSION_IDLE_MS);
    }
    session = null;
  });
});

superviseTailnet();
setInterval(superviseTailnet, 15000);

server.listen(PORT, HOST, () => {
  console.log(`Claude Remote → http://${HOST}:${PORT}`);
  if (!["127.0.0.1", "localhost", "::1"].includes(HOST))
    console.warn("⚠ Abierto a la red local SIN cifrar: la clave de la app viaja en texto plano. Usá Tailscale.");
  console.log(`Push FCM: ${pushEnabled() ? `activo (${pushCredential()})` : "desactivado (falta firebase-service-account.json o push-sender.json)"}`);
  console.log(`Acceso: ${APP_ONLY ? "solo la app vinculada (npm run pair genera el código)" : "SIN clave (APP_ONLY=0)"}`);
});
