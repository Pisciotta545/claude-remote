// --- Terminal --------------------------------------------------------------
const term = new Terminal({
  cursorBlink: true,
  fontFamily: "monospace",
  fontSize: 13,
  scrollback: 5000, // historial amplio para poder subir a ver mensajes anteriores
  theme: { background: "#0f172a", foreground: "#e2e8f0" },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("terminal"));

// --- Elementos -------------------------------------------------------------
const status = document.getElementById("conn-status");
const picker = document.getElementById("picker");
const terminalEl = document.getElementById("terminal");
const quickbar = document.getElementById("quickbar");
const backBtn = document.getElementById("backBtn");
const stopBtn = document.getElementById("stopBtn");
const scrollBottomBtn = document.getElementById("scrollBottomBtn");
const projName = document.getElementById("proj-name");
const projList = document.getElementById("proj-list");
const pickerHint = document.getElementById("picker-hint");

let ws;
let currentProject = null; // { name, path }

// Escapa texto para insertarlo en innerHTML sin romper el markup.
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// --- Vistas ----------------------------------------------------------------
function showPicker() {
  currentProject = null;
  if (ws) {
    ws.onclose = null; // evita la reconexión automática al cerrar a propósito
    ws.close();
    ws = null;
  }
  term.reset();
  picker.classList.remove("hidden");
  terminalEl.classList.add("hidden");
  quickbar.classList.add("hidden");
  backBtn.classList.add("hidden");
  stopBtn.classList.add("hidden");
  scrollBottomBtn.classList.add("hidden");
  projName.textContent = "Uso de tokens";
  window.__crInProject = false; // el botón físico de Android sale de la app
  loadProjects();
}

function openProject(proj) {
  currentProject = proj;
  picker.classList.add("hidden");
  terminalEl.classList.remove("hidden");
  quickbar.classList.remove("hidden");
  backBtn.classList.remove("hidden");
  stopBtn.classList.remove("hidden");
  projName.textContent = proj.name;
  window.__crInProject = true; // el botón físico de Android vuelve al selector
  fit.fit();
  connect();
  term.focus();
}

// Flecha ←: vuelve al selector pero DEJA la sesión corriendo en segundo plano.
backBtn.addEventListener("click", showPicker);

// Puente con el botón físico "atrás" de la app Android (ver MainActivity).
window.__crInProject = false;
window.__crGoBack = () => showPicker();

// Puente para abrir un proyecto por ruta al tocar la notificación push.
window.__crOpenProject = (path) => {
  if (!path) return;
  const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
  if (ws) { ws.onclose = null; ws.close(); ws = null; } // corta la sesión anterior
  openProject({ name, path });
};

// "Cerrar": detiene el proceso de esta carpeta (la memoria queda guardada y se
// reanuda con --continue al reabrir). Luego vuelve al selector.
stopBtn.addEventListener("click", () => {
  if (!currentProject) return;
  if (!confirm(`¿Cerrar la sesión de "${currentProject.name}"?\nSe detiene el proceso en curso. La conversación queda guardada y se reanuda al reabrir el proyecto.`)) return;
  send({ type: "stop" });
  showPicker();
});

// --- Lista de proyectos ----------------------------------------------------
// Detiene una sesión en segundo plano desde el selector (botón ✕).
async function stopSession(path, name) {
  if (!confirm(`¿Cerrar la sesión en segundo plano de "${name}"?`)) return;
  try {
    await fetch("/api/sessions/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
  } catch { /* si falla, el próximo refresco lo mostrará igual */ }
  loadProjects();
}

async function loadProjects() {
  pickerHint.textContent = "Cargando…";
  projList.innerHTML = "";
  try {
    const [pRes, sRes] = await Promise.all([
      fetch("/api/projects"),
      fetch("/api/sessions").catch(() => null),
    ]);
    const data = await pRes.json();
    const projects = data.projects || [];
    // Carpetas con proceso vivo en segundo plano (para marcarlas "en curso").
    let active = new Set();
    try {
      const s = sRes && (await sRes.json());
      active = new Set((s?.sessions || []).map((x) => x.path.toLowerCase()));
    } catch { /* sin sesiones activas */ }

    if (!projects.length) {
      pickerHint.textContent = "No se encontraron proyectos.";
      return;
    }
    pickerHint.textContent =
      `${projects.length} proyectos` + (active.size ? ` · ${active.size} en curso` : "");

    for (const p of projects) {
      const running = active.has(p.path.toLowerCase());
      const row = document.createElement("div");
      row.className = "flex items-stretch gap-2";

      const btn = document.createElement("button");
      btn.title = p.path;
      btn.className =
        "flex-1 min-w-0 text-left bg-slate-800 active:bg-emerald-600 rounded-lg px-4 py-3 text-sm flex items-center gap-2";
      btn.innerHTML = running
        ? `<span class="w-2 h-2 rounded-full bg-emerald-400 shrink-0 animate-pulse"></span>` +
          `<span class="truncate">${escapeHtml(p.name)}</span>` +
          `<span class="ml-auto text-[10px] text-emerald-400 shrink-0">en curso</span>`
        : `<span class="truncate">${escapeHtml(p.name)}</span>`;
      btn.addEventListener("click", () => openProject(p));
      row.appendChild(btn);

      if (running) {
        const close = document.createElement("button");
        close.textContent = "✕";
        close.title = "Cerrar sesión en segundo plano";
        close.className =
          "bg-slate-800 active:bg-red-600 rounded-lg px-3 text-red-400 shrink-0";
        close.addEventListener("click", (e) => {
          e.stopPropagation();
          stopSession(p.path, p.name);
        });
        row.appendChild(close);
      }
      projList.appendChild(row);
    }
  } catch {
    pickerHint.textContent = "Error al cargar proyectos. ¿El servidor está corriendo?";
  }
}

// --- WebSocket -------------------------------------------------------------
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    status.textContent = "● conectado";
    status.className = "text-emerald-400";
    if (currentProject) send({ type: "start", cwd: currentProject.path });
    sendResize();
  };
  ws.onclose = () => {
    status.textContent = "● desconectado";
    status.className = "text-red-400";
    if (currentProject) setTimeout(() => currentProject && connect(), 2000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "output") term.write(msg.data);
    // Reconexión: el servidor reenvía lo que ya había en pantalla.
    else if (msg.type === "restore") { term.reset(); term.write(msg.data); }
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

// Botón "↓": aparece al subir a leer el historial; toca para volver al final.
term.onScroll(() => {
  const b = term.buffer.active;
  scrollBottomBtn.classList.toggle("hidden", b.viewportY >= b.baseY);
});
scrollBottomBtn.addEventListener("click", () => {
  term.scrollToBottom();
  scrollBottomBtn.classList.add("hidden");
  term.focus();
});

// Scroll táctil: dentro del WebView xterm no desplaza el historial con el dedo,
// así que traducimos el arrastre vertical en líneas de scroll. Arrastrar hacia
// abajo muestra lo anterior; hacia arriba, lo más nuevo.
let touchY = null, touchAcc = 0, touchMoved = false;
const cellPx = () => Math.max(1, terminalEl.clientHeight / (term.rows || 24));
terminalEl.addEventListener("touchstart", (e) => {
  if (e.touches.length !== 1) { touchY = null; return; }
  touchY = e.touches[0].clientY;
  touchAcc = 0;
  touchMoved = false;
}, { passive: true });
terminalEl.addEventListener("touchmove", (e) => {
  if (touchY == null || e.touches.length !== 1) return;
  const y = e.touches[0].clientY;
  touchAcc += y - touchY;
  touchY = y;
  const lines = Math.trunc(touchAcc / cellPx());
  if (lines !== 0) {
    term.scrollLines(-lines);
    touchAcc -= lines * cellPx();
    touchMoved = true;
  }
}, { passive: true });
// Si el gesto fue un scroll (no un toque), evitamos que abra el teclado.
terminalEl.addEventListener("touchend", () => {
  if (touchMoved) setTimeout(() => term.blur(), 0);
  touchY = null;
}, { passive: true });

// --- Ajuste responsivo -----------------------------------------------------
const onResize = () => {
  if (terminalEl.classList.contains("hidden")) return;
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
    else return; // botones sin cmd/key (p. ej. "Uso") manejan su propio click
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

// Formatea milisegundos como HH:MM:SS (nunca negativo).
function fmtHMS(ms) {
  const diff = Math.max(0, ms);
  const h = String(Math.floor(diff / 3.6e6)).padStart(2, "0");
  const m = String(Math.floor((diff % 3.6e6) / 6e4)).padStart(2, "0");
  const s = String(Math.floor((diff % 6e4) / 1e3)).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function paintTimer() {
  if (!resetAt) return;
  timer.textContent = fmtHMS(resetAt - Date.now());
}

// --- Panel de uso detallado (botón "Uso") ----------------------------------
const usageModal = document.getElementById("usage-modal");
const usageWindows = document.getElementById("usage-windows");
const usageUpdated = document.getElementById("usage-updated");

// Etiquetas legibles por ventana; las desconocidas usan su clave.
const WINDOW_LABELS = {
  five_hour: "Cada 5 horas",
  seven_day: "Semanal",
  seven_day_opus: "Semanal · Opus",
};

let latestWindows = {};
let lastUsageAt = null;

// Convierte utilization (0–1 o 0–100) a porcentaje entero.
const toPct = (u) => (u == null ? null : Math.round(u <= 1 ? u * 100 : u));

const usageOpen = () => !usageModal.classList.contains("hidden");

function renderUsageModal() {
  const keys = Object.keys(latestWindows);
  if (!keys.length) {
    usageWindows.innerHTML =
      '<p class="text-sm text-slate-400">Sin datos de uso todavía.</p>';
    return;
  }
  // Orden preferido: 5 h, semanal, y el resto después.
  const order = ["five_hour", "seven_day", "seven_day_opus"];
  keys.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));

  usageWindows.innerHTML = keys
    .map((k) => {
      const w = latestWindows[k];
      const used = toPct(w.utilization);
      const left = used == null ? null : Math.max(0, 100 - used);
      const label = WINDOW_LABELS[k] || k.replace(/_/g, " ");
      const color =
        left == null ? "bg-slate-500"
        : left > 30 ? "bg-emerald-500"
        : left > 10 ? "bg-amber-500"
        : "bg-red-500";
      let resetTxt = "—";
      if (w.resets_at) {
        const d = new Date(w.resets_at);
        resetTxt = `${fmtHMS(d.getTime() - Date.now())} · ${d.toLocaleString()}`;
      }
      return `
      <div>
        <div class="flex items-baseline justify-between mb-1">
          <span class="text-sm font-semibold">${label}</span>
          <span class="text-sm font-mono ${left != null && left <= 10 ? "text-red-400" : "text-emerald-400"}">${left == null ? "—" : left + "% libre"}</span>
        </div>
        <div class="w-full bg-slate-700 rounded-full h-2 overflow-hidden">
          <div class="${color} h-2 rounded-full" style="width:${left == null ? 0 : left}%"></div>
        </div>
        <div class="text-[11px] text-slate-400 mt-1">Usado ${used == null ? "—" : used + "%"} · se restaura en <span class="font-mono text-amber-400">${resetTxt}</span></div>
      </div>`;
    })
    .join("");

  usageUpdated.textContent = lastUsageAt
    ? `Actualizado ${new Date(lastUsageAt).toLocaleTimeString()}`
    : "";
}

document.getElementById("usageBtn").addEventListener("click", () => {
  usageModal.classList.remove("hidden");
  renderUsageModal();
  fetchUsage(); // refresca al abrir
});
document.getElementById("usage-close").addEventListener("click", () =>
  usageModal.classList.add("hidden"));
usageModal.addEventListener("click", (e) => {
  if (e.target === usageModal) usageModal.classList.add("hidden"); // toca fuera → cierra
});

async function fetchUsage() {
  try {
    const res = await fetch("/api/usage");
    const data = await res.json();
    if (data.utilization != null) paintBar(toPct(data.utilization));
    if (data.resets_at) resetAt = new Date(data.resets_at).getTime();
    if (data.windows) { latestWindows = data.windows; lastUsageAt = Date.now(); }
    if (usageOpen()) renderUsageModal();
  } catch {
    /* silencioso: se reintenta en el próximo ciclo */
  }
}

// --- PWA -------------------------------------------------------------------
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// --- Inicio ----------------------------------------------------------------
showPicker();
fetchUsage();
setInterval(fetchUsage, 30000); // refresca métricas cada 30 s
setInterval(() => {
  paintTimer();
  if (usageOpen()) renderUsageModal(); // refresca la cuenta regresiva del panel
}, 1000);
