import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { spawn } from "node-pty";
import { readFile, readdir, stat } from "fs/promises";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { homedir } from "os";
import { join, dirname, resolve, sep, basename } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const SHELL = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "bash");
const CLAUDE_CMD = process.env.CLAUDE_CMD || "claude --dangerously-skip-permissions";
const START_DIR = process.env.CLAUDE_CWD || homedir();
// Raíces donde buscar proyectos (por defecto, la carpeta que contiene este repo).
const PROJECTS_ROOTS = (process.env.PROJECTS_DIRS || dirname(__dirname))
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => resolve(s));
const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
// Carpetas donde ya usaste Claude (le "diste permiso"); su ruta real vive en las sesiones.
const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
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

// Argumentos según el shell REAL, no según el SO (evita mezclar estilos).
function shellArgs(shell, cmd) {
  const name = shell.toLowerCase();
  if (name.includes("powershell") || name.includes("pwsh")) return ["-NoLogo", "-Command", cmd];
  if (name.includes("cmd")) return ["/c", cmd];
  return ["-lc", cmd]; // bash/zsh/sh y demás POSIX
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

// Rutas reales de todas las carpetas donde ya se usó Claude, con caché corto.
let _knownCache = { at: 0, paths: [] };
async function listKnownProjectPaths() {
  if (Date.now() - _knownCache.at < 10_000) return _knownCache.paths;
  const out = [];
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

const app = express();
const server = createServer(app);

// Red superior: un error de socket transitorio (p. ej. al cambiar de Wi-Fi)
// no debe tumbar el proceso. Se registra y se sigue sirviendo.
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
server.on("error", (err) => {
  console.error("[http error]", err);
  if (err.code === "EADDRINUSE") process.exit(1); // el supervisor reintenta
});

app.use(express.json());
app.use(express.static(join(__dirname, "public")));

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
      return res
        .status(upstream.status)
        .json({ error: `API respondió ${upstream.status}` });
    }

    const data = await upstream.json();
    // Detecta todas las ventanas de uso (five_hour, seven_day, …) sin descartar el payload.
    const windows = {};
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && ("utilization" in v || "resets_at" in v)) {
        windows[k] = { utilization: v.utilization ?? null, resets_at: v.resets_at ?? null };
      }
    }
    res.json({
      utilization: data.utilization ?? data.five_hour?.utilization ?? null,
      resets_at: data.resets_at ?? data.five_hour?.resets_at ?? null,
      windows,
      raw: data,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Autoactualización del APK ---------------------------------------------
app.get("/api/app-version", async (_req, res) => {
  try {
    const info = JSON.parse(await readFile(APP_VERSION_PATH, "utf8"));
    res.json({
      versionCode: info.versionCode,
      versionName: info.versionName,
      url: "/download/app.apk",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/download/app.apk", (_req, res) => {
  res.download(APK_PATH, "claude-remote.apk", (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "APK no disponible" });
  });
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
const wss = new WebSocketServer({ server, path: "/ws" });

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

wss.on("connection", (ws) => {
  let session = null;
  let key = null;

  async function attach(cwd, fresh) {
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
          cols: 80,
          rows: 24,
          cwd: dir,
          env: process.env,
        });
      } catch (err) {
        if (ws.readyState === ws.OPEN)
          ws.send(JSON.stringify({ type: "output", data: `\r\n[error al iniciar: ${err.message}]\r\n` }));
        return;
      }

      s = { pty, cwd: dir, buffer: [], bytes: 0, clients: new Set(), killTimer: null };
      sessions.set(key, s);

      pty.onData((data) => {
        pushBuffer(s, data);
        broadcast(s, { type: "output", data });
      });

      pty.onExit(({ exitCode }) => {
        if (s.killTimer) clearTimeout(s.killTimer);
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
  }

  ws.on("message", (msg) => {
    try {
      const { type, data, cols, rows, cwd, fresh } = JSON.parse(msg.toString());
      if (type === "start") attach(cwd, fresh);
      else if (type === "input" && session?.pty) session.pty.write(data);
      else if (type === "resize" && session?.pty) session.pty.resize(cols, rows);
      else if (type === "stop" && key) stopSession(key); // "Cerrar": detiene el proceso
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

server.listen(PORT, HOST, () => {
  console.log(`Claude Remote → http://${HOST}:${PORT}`);
});
