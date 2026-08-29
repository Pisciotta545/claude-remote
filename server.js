import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { spawn } from "node-pty";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const SHELL = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "bash");
const CLAUDE_CMD = process.env.CLAUDE_CMD || "claude";
const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
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

// --- Terminal PTY vía WebSocket -------------------------------------------
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  const pty = spawn(SHELL, process.platform === "win32" ? ["-NoLogo", "-Command", CLAUDE_CMD] : ["-lc", CLAUDE_CMD], {
    name: "xterm-color",
    cols: 80,
    rows: 24,
    cwd: process.env.HOME || homedir(),
    env: process.env,
  });

  pty.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "output", data }));
  });

  pty.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "exit", code: exitCode }));
      ws.close();
    }
  });

  ws.on("message", (msg) => {
    try {
      const { type, data, cols, rows } = JSON.parse(msg.toString());
      if (type === "input") pty.write(data);
      else if (type === "resize") pty.resize(cols, rows);
    } catch {
      /* ignora frames malformados */
    }
  });

  ws.on("close", () => pty.kill());
});

server.listen(PORT, HOST, () => {
  console.log(`Claude Remote → http://${HOST}:${PORT}`);
});
