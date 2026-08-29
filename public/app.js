// --- Terminal --------------------------------------------------------------
const term = new Terminal({
  cursorBlink: true,
  fontFamily: "monospace",
  fontSize: 13,
  theme: { background: "#0f172a", foreground: "#e2e8f0" },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("terminal"));
fit.fit();

// --- WebSocket -------------------------------------------------------------
const status = document.getElementById("conn-status");
let ws;

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    status.textContent = "● conectado";
    status.className = "text-emerald-400";
    sendResize();
  };
  ws.onclose = () => {
    status.textContent = "● desconectado";
    status.className = "text-red-400";
    setTimeout(connect, 2000); // reconexión automática
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "output") term.write(msg.data);
    else if (msg.type === "exit") term.write(`\r\n[proceso finalizado: ${msg.code}]\r\n`);
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function sendResize() {
  send({ type: "resize", cols: term.cols, rows: term.rows });
}

term.onData((data) => send({ type: "input", data }));

// --- Ajuste responsivo -----------------------------------------------------
const onResize = () => {
  fit.fit();
  sendResize();
};
window.addEventListener("resize", onResize);
window.addEventListener("orientationchange", () => setTimeout(onResize, 300));

// --- Botones rápidos -------------------------------------------------------
const KEYS = { esc: "\x1b", tab: "\t", ctrlc: "\x03" };
document.querySelectorAll("#quickbar button").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.cmd) send({ type: "input", data: btn.dataset.cmd + "\r" });
    else if (btn.dataset.key) send({ type: "input", data: KEYS[btn.dataset.key] });
    term.focus();
  });
});

// --- Métricas de uso -------------------------------------------------------
const bar = document.getElementById("usage-bar");
const label = document.getElementById("usage-label");
const timer = document.getElementById("reset-timer");
let resetAt = null;

function paintBar(pct) {
  bar.style.width = `${pct}%`;
  bar.className =
    "h-2.5 rounded-full transition-all duration-500 " +
    (pct < 70 ? "bg-emerald-500" : pct < 90 ? "bg-amber-500" : "bg-red-500");
  label.textContent = `${pct}%`;
}

function paintTimer() {
  if (!resetAt) return;
  const diff = Math.max(0, resetAt - Date.now());
  const h = String(Math.floor(diff / 3.6e6)).padStart(2, "0");
  const m = String(Math.floor((diff % 3.6e6) / 6e4)).padStart(2, "0");
  const s = String(Math.floor((diff % 6e4) / 1e3)).padStart(2, "0");
  timer.textContent = `${h}:${m}:${s}`;
}

async function fetchUsage() {
  try {
    const res = await fetch("/api/usage");
    const data = await res.json();
    if (data.utilization != null) paintBar(Math.round(data.utilization * (data.utilization <= 1 ? 100 : 1)));
    if (data.resets_at) resetAt = new Date(data.resets_at).getTime();
  } catch {
    /* silencioso: se reintenta en el próximo ciclo */
  }
}

// --- PWA -------------------------------------------------------------------
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

connect();
fetchUsage();
setInterval(fetchUsage, 30000); // refresca métricas cada 30 s
setInterval(paintTimer, 1000); // cuenta regresiva cada 1 s
