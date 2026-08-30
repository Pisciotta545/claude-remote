import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { spawn } from "node-pty";
import { readFile, readdir } from "fs/promises";
import { homedir } from "os";
import { join, dirname, resolve, sep } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const SHELL = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "bash");
const CLAUDE_CMD = process.env.CLAUDE_CMD || "claude";
const START_DIR = process.env.CLAUDE_CWD || homedir();
// Raíces donde buscar proyectos (por defecto, la carpeta que contiene este repo).
const PROJECTS_ROOTS = (process.env.PROJECTS_DIRS || dirname(__dirname))
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => resolve(s));
const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
// Autoactualización del APK.
const APK_PATH = process.env.APK_PATH || join(__dirname, "claude-remote.apk");
const APP_VERSION_PATH = join(__dirname, "app-version.json");

// Argumentos según el shell REAL, no según el SO (evita mezclar estilos).
function shellArgs(shell, cmd) {
  const name = shell.toLowerCase();
  if (name.includes("powershell") || name.includes("pwsh")) return ["-NoLogo", "-Command", cmd];
  if (name.includes("cmd")) return ["/c", cmd];
  return ["-lc", cmd]; // bash/zsh/sh y demás POSIX
}

// Solo permite iniciar Claude dentro de una raíz configurada.
function isAllowed(p) {
  if (!p) return false;
  const rp = resolve(p);
  return PROJECTS_ROOTS.some((root) => rp === root || rp.startsWith(root + sep));
}
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

const app = express();
const server = createServer(app);

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
    // Normaliza los campos relevantes sin descartar el payload original.
    res.json({
      utilization: data.utilization ?? data.five_hour?.utilization ?? null,
      resets_at: data.resets_at ?? data.five_hour?.resets_at ?? null,
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
    const out = [];
    for (const root of PROJECTS_ROOTS) {
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        continue; // raíz inexistente: la ignora
      }
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith(".")) {
          out.push({ name: e.name, path: join(root, e.name) });
        }
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ projects: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Terminal PTY vía WebSocket -------------------------------------------
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  let pty = null;

  function startPty(cwd) {
    if (pty) return;
    const dir = isAllowed(cwd) ? cwd : START_DIR;
    try {
      pty = spawn(SHELL, shellArgs(SHELL, CLAUDE_CMD), {
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

    pty.onData((data) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "output", data }));
    });

    pty.onExit(({ exitCode }) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "exit", code: exitCode }));
        ws.close();
      }
    });
  }

  ws.on("message", (msg) => {
    try {
      const { type, data, cols, rows, cwd } = JSON.parse(msg.toString());
      if (type === "start") startPty(cwd);
      else if (type === "input" && pty) pty.write(data);
      else if (type === "resize" && pty) pty.resize(cols, rows);
    } catch {
      /* ignora frames malformados */
    }
  });

  ws.on("close", () => {
    if (pty) pty.kill();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Claude Remote → http://${HOST}:${PORT}`);
});
