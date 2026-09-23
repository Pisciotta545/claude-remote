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

// Abre URLs en el navegador del sistema. En la app Android usa el puente nativo
// (`CRNative`, más fiable sobre HTTP local); en un navegador normal, window.open.
function openUrl(url) {
  if (!url) return;
  if (window.CRNative && CRNative.openUrl) { CRNative.openUrl(url); return; }
  window.open(url, "_blank", "noopener");
}

term.open(document.getElementById("terminal"));

// --- Elementos -------------------------------------------------------------
const status = document.getElementById("conn-status");
const picker = document.getElementById("picker");
const terminalEl = document.getElementById("terminal");
const quickbar = document.getElementById("quickbar");
const backBtn = document.getElementById("backBtn");
const stopBtn = document.getElementById("stopBtn");
const scrollCtrls = document.getElementById("scrollCtrls");
const scrollUpBtn = document.getElementById("scrollUpBtn");
const scrollDownBtn = document.getElementById("scrollDownBtn");
const scrollBottomBtn = document.getElementById("scrollBottomBtn");
const projName = document.getElementById("proj-name");
const projList = document.getElementById("proj-list");
const pickerHint = document.getElementById("picker-hint");

let ws;
let currentProject = null; // { name, path }

// --- Diálogo de confirmación propio (en vez del confirm() nativo) ----------
const confirmModal = document.getElementById("confirm-modal");
const confirmTitle = document.getElementById("confirm-title");
const confirmMsg = document.getElementById("confirm-msg");
const confirmOk = document.getElementById("confirm-ok");
const confirmCancel = document.getElementById("confirm-cancel");
let confirmResolver = null;

function crConfirm({ title = "Confirmar", message = "", okText = "Cerrar" } = {}) {
  confirmTitle.textContent = title;
  confirmMsg.textContent = message;
  confirmOk.textContent = okText;
  confirmModal.classList.remove("hidden");
  return new Promise((resolve) => (confirmResolver = resolve));
}
function closeConfirm(val) {
  confirmModal.classList.add("hidden");
  if (confirmResolver) { confirmResolver(val); confirmResolver = null; }
}
confirmOk.addEventListener("click", () => closeConfirm(true));
confirmCancel.addEventListener("click", () => closeConfirm(false));
confirmModal.addEventListener("click", (e) => { if (e.target === confirmModal) closeConfirm(false); });

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
  scrollCtrls.classList.add("hidden");
  document.getElementById("build-modal").classList.add("hidden"); // se reofrece al volver
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
  scrollCtrls.classList.remove("hidden");
  projName.textContent = proj.name;
  window.__crInProject = true; // el botón físico de Android vuelve al selector
  // Espera a que el contenedor recién mostrado tenga layout antes de medir, para
  // que fit() calcule bien las columnas y el PTY arranque con el tamaño correcto
  // (si mide mal, Claude dibuja a otro ancho y la pantalla queda descuadrada).
  requestAnimationFrame(() => requestAnimationFrame(() => {
    fit.fit();
    connect();
    term.focus();
  }));
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
stopBtn.addEventListener("click", async () => {
  if (!currentProject) return;
  const ok = await crConfirm({
    title: `Cerrar "${currentProject.name}"`,
    message: "Se detiene el proceso en curso. La conversación queda guardada y se reanuda al reabrir el proyecto.",
    okText: "Cerrar",
  });
  if (!ok) return;
  const path = currentProject.path;
  showPicker(); // vuelve al selector y corta el WS
  // Detiene la sesión por HTTP (no depende del timing del WebSocket).
  try {
    await fetch("/api/sessions/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
  } catch { /* si falla, seguirá figurando "en curso" y se puede reintentar */ }
  loadProjects(); // refresca el estado "en curso"
});

// --- Lista de proyectos ----------------------------------------------------
// Detiene una sesión en segundo plano desde el selector (botón ✕).
async function stopSession(path, name) {
  const ok = await crConfirm({
    title: `Cerrar "${name}"`,
    message: "Se detiene la sesión en segundo plano. La memoria se guarda y se reanuda al reabrir.",
    okText: "Cerrar",
  });
  if (!ok) return;
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
    // Manda el tamaño en el "start" para que el PTY arranque directo con él.
    if (currentProject)
      send({ type: "start", cwd: currentProject.path, cols: term.cols, rows: term.rows });
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
    // Reconexión: el servidor reenvía lo que ya había en pantalla. Tras
    // restaurar, re-mide y re-sincroniza el tamaño con el PTY (por si cambió
    // mientras no había WS) para que el redibujo de Claude quede alineado.
    else if (msg.type === "restore") {
      term.reset();
      term.write(msg.data);
      fit.fit();
      sendResize();
    }
    else if (msg.type === "exit") term.write(`\r\n[proceso finalizado: ${msg.code}]\r\n`);
    else if (msg.type === "build") showBuild(msg.builds || []);
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function sendResize() {
  send({ type: "resize", cols: term.cols, rows: term.rows });
}

term.onData((data) => send({ type: "input", data }));

// Claude corre en "pantalla alternativa" (como vim/less): el scrollback de
// xterm queda vacío. Pero Claude activa el modo mouse (?1000/1002/1003/1006h) y
// maneja su propio historial con la RUEDA, así que scrolleamos enviándole
// eventos de rueda por SGR (\x1b[<64;x;yM = arriba, 65 = abajo).
function wheel(dir, times = 3) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const btn = dir < 0 ? 64 : 65; // <0 = arriba (ver lo anterior)
  const x = Math.max(1, Math.round((term.cols || 80) / 2));
  const y = Math.max(1, Math.round((term.rows || 24) / 2));
  let seq = "";
  for (let i = 0; i < times; i++) seq += `\x1b[<${btn};${x};${y}M`;
  send({ type: "input", data: seq });
}
scrollUpBtn.addEventListener("click", () => wheel(-1, 3));
scrollDownBtn.addEventListener("click", () => wheel(1, 3));
// Claude ofrece "Jump to bottom (ctrl+End)": es el salto directo al final.
scrollBottomBtn.addEventListener("click", () => send({ type: "input", data: "\x1b[1;5F" }));

// Scroll táctil: traducimos el arrastre vertical del dedo en eventos de rueda.
// Capturamos en el elemento de xterm (fase de captura). Arrastrar hacia abajo
// muestra lo anterior; hacia arriba, lo más nuevo.
const scrollHost = term.element || terminalEl;
const STEP_PX = 22; // px de arrastre por "clic" de rueda
let touchY = null, touchAcc = 0, touchMoved = false;
scrollHost.addEventListener("touchstart", (e) => {
  if (e.touches.length !== 1) { touchY = null; return; }
  touchY = e.touches[0].clientY;
  touchAcc = 0;
  touchMoved = false;
}, { passive: true, capture: true });
scrollHost.addEventListener("touchmove", (e) => {
  if (touchY == null || e.touches.length !== 1) return;
  const y = e.touches[0].clientY;
  touchAcc += y - touchY;
  touchY = y;
  const steps = Math.trunc(touchAcc / STEP_PX);
  if (steps !== 0) {
    wheel(steps > 0 ? -1 : 1, Math.abs(steps)); // arrastrar abajo → lo anterior
    touchAcc -= steps * STEP_PX;
    touchMoved = true;
  }
}, { passive: true, capture: true });
scrollHost.addEventListener("touchend", () => {
  if (touchMoved) setTimeout(() => term.blur(), 0); // fue scroll: no abras teclado
  touchY = null;
}, { passive: true, capture: true });

// --- Ajuste responsivo -----------------------------------------------------
const onResize = () => {
  if (terminalEl.classList.contains("hidden")) return;
  fit.fit();
  sendResize();
};
// Debounce: al abrir el teclado o rotar llegan varios eventos seguidos; medir en
// cada uno descuadra la terminal. Se ajusta una sola vez cuando se estabiliza.
let resizeTimer = null;
const scheduleResize = () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(onResize, 150);
};
window.addEventListener("resize", scheduleResize);
window.addEventListener("orientationchange", () => setTimeout(onResize, 300));
// El teclado virtual no siempre dispara "resize" de window; visualViewport sí.
if (window.visualViewport) window.visualViewport.addEventListener("resize", scheduleResize);

// --- Teclas ----------------------------------------------------------------
// Secuencias que manda cada tecla. Un array = varias pulsaciones separadas (p. ej.
// Esc Esc: juntas, la terminal las leería como Alt+Esc).
const KEYS = {
  esc: "\x1b", tab: "\t", stab: "\x1b[Z", enter: "\r", ctrlc: "\x03",
  up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
  escesc: ["\x1b", "\x1b"], newline: "\x1b\r", bksp: "\x7f",
  ctrlo: "\x0f", ctrlt: "\x14", ctrlb: "\x02", ctrlr: "\x12", ctrll: "\x0c",
  ctrla: "\x01", ctrle: "\x05", ctrlu: "\x15", ctrlk: "\x0b", ctrlw: "\x17", undo: "\x1f",
  altp: "\x1bp", altt: "\x1bt", pgup: "\x1b[5~", pgdn: "\x1b[6~", ctrlend: "\x1b[1;5F",
  bang: "!", at: "@", slash: "/",
};
function sendKey(name) {
  const seq = KEYS[name];
  if (seq == null) return;
  if (Array.isArray(seq)) seq.forEach((s, i) => setTimeout(() => send({ type: "input", data: s }), i * 150));
  else send({ type: "input", data: seq });
}

// Barra de teclas: solo foco en la terminal si el teclado ya estaba abierto,
// para no tapar la pantalla cada vez que se navega con las flechas.
document.querySelectorAll("#keybar button[data-key]").forEach((btn) => {
  btn.addEventListener("click", () => sendKey(btn.dataset.key));
});

// Panel "⌨ Más": todos los atajos del CLI con qué hacen.
const MORE_KEYS = [
  ["escesc", "Esc Esc", "Volver atrás / editar un mensaje anterior"],
  ["stab", "Shift+Tab", "Modo: normal → aceptar ediciones → plan"],
  ["newline", "Nueva línea", "Salto de línea sin enviar"],
  ["bksp", "⌫ Borrar", "Borra un carácter"],
  ["ctrlo", "Ctrl+O", "Ver detalle / transcripción"],
  ["ctrlt", "Ctrl+T", "Mostrar/ocultar lista de tareas"],
  ["ctrlb", "Ctrl+B", "Mandar comando a segundo plano"],
  ["ctrlr", "Ctrl+R", "Buscar en el historial"],
  ["ctrll", "Ctrl+L", "Redibujar la pantalla"],
  ["altp", "Alt+P", "Cambiar de modelo"],
  ["altt", "Alt+T", "Activar/desactivar pensamiento"],
  ["undo", "Ctrl+_", "Deshacer lo escrito"],
  ["ctrla", "Ctrl+A", "Ir al inicio de la línea"],
  ["ctrle", "Ctrl+E", "Ir al final de la línea"],
  ["ctrlu", "Ctrl+U", "Borrar hasta el inicio"],
  ["ctrlk", "Ctrl+K", "Borrar hasta el final"],
  ["ctrlw", "Ctrl+W", "Borrar la palabra anterior"],
  ["pgup", "RePág", "Subir una página"],
  ["pgdn", "AvPág", "Bajar una página"],
  ["ctrlend", "Ctrl+Fin", "Ir al final de la conversación"],
  ["bang", "!", "Modo bash: correr un comando de shell"],
  ["at", "@", "Mencionar un archivo"],
  ["slash", "/", "Empezar un comando"],
  ["ctrlc", "Ctrl+C", "Cancelar / interrumpir"],
];
const keysModal = document.getElementById("keys-modal");
const keysList = document.getElementById("keys-list");
for (const [key, label, desc] of MORE_KEYS) {
  const b = document.createElement("button");
  b.className = "text-left bg-slate-700 active:bg-emerald-600 rounded-lg px-3 py-2";
  b.innerHTML = `<div class="text-sm font-mono">${escapeHtml(label)}</div>` +
    `<div class="text-[11px] text-slate-400 leading-tight">${escapeHtml(desc)}</div>`;
  b.addEventListener("click", () => {
    keysModal.classList.add("hidden");
    sendKey(key);
    if (["bang", "at", "slash", "newline"].includes(key)) term.focus(); // sigue escribiendo
  });
  keysList.appendChild(b);
}
document.getElementById("keysBtn").addEventListener("click", () => keysModal.classList.remove("hidden"));
document.getElementById("keys-close").addEventListener("click", () => keysModal.classList.add("hidden"));
keysModal.addEventListener("click", (e) => { if (e.target === keysModal) keysModal.classList.add("hidden"); });

// --- Menú de comandos "/" --------------------------------------------------
// Comandos del CLI. `arg: true` = necesita texto: se escribe sin Enter para completarlo.
const BUILTIN_COMMANDS = [
  ["/compact", "Resumir la conversación para liberar contexto"],
  ["/clear", "Empezar una conversación nueva"],
  ["/model", "Cambiar de modelo"],
  ["/resume", "Retomar una conversación anterior"],
  ["/rewind", "Volver a un punto anterior (chat y código)"],
  ["/context", "Ver cuánto contexto se está usando"],
  ["/usage", "Límites y uso del plan"],
  ["/cost", "Costo y tokens de la sesión"],
  ["/status", "Versión, cuenta, modelo y conexión"],
  ["/config", "Configuración"],
  ["/permissions", "Reglas de permisos"],
  ["/memory", "Archivos de memoria (CLAUDE.md)"],
  ["/init", "Crear CLAUDE.md para el proyecto"],
  ["/add-dir", "Agregar otra carpeta de trabajo", true],
  ["/agents", "Gestionar subagentes"],
  ["/mcp", "Servidores MCP"],
  ["/hooks", "Hooks"],
  ["/plugin", "Plugins"],
  ["/review", "Revisar un pull request"],
  ["/code-review", "Revisar los cambios buscando bugs"],
  ["/security-review", "Revisión de seguridad de los cambios"],
  ["/simplify", "Simplificar el código cambiado"],
  ["/pr-comments", "Ver comentarios de un PR"],
  ["/todos", "Lista de tareas actual"],
  ["/tasks", "Tareas en segundo plano"],
  ["/export", "Exportar la conversación"],
  ["/output-style", "Estilo de respuesta"],
  ["/fast", "Modo rápido"],
  ["/vim", "Modo de edición vim"],
  ["/doctor", "Diagnóstico de la instalación"],
  ["/release-notes", "Novedades de la versión"],
  ["/feedback", "Enviar feedback a Anthropic"],
  ["/login", "Iniciar sesión"],
  ["/logout", "Cerrar sesión"],
  ["/help", "Ayuda y lista completa de comandos"],
  ["/exit", "Salir de Claude"],
].map(([cmd, desc, arg]) => ({ cmd, desc, arg: !!arg, scope: "Claude Code" }));

const cmdModal = document.getElementById("cmd-modal");
const cmdSearch = document.getElementById("cmd-search");
const cmdList = document.getElementById("cmd-list");
let customCommands = [];

function runCommand(c) {
  cmdModal.classList.add("hidden");
  if (c.arg) { send({ type: "input", data: c.cmd + " " }); term.focus(); } // falta el argumento
  else send({ type: "input", data: c.cmd + "\r" });
}

function renderCommands() {
  const q = cmdSearch.value.trim().toLowerCase().replace(/^\//, "");
  const match = (c) => !q || c.cmd.toLowerCase().includes(q) || (c.desc || "").toLowerCase().includes(q);
  const all = [...customCommands, ...BUILTIN_COMMANDS].filter(match);
  cmdList.innerHTML = "";
  if (!all.length) {
    cmdList.innerHTML = `<p class="text-sm text-slate-400">Sin coincidencias. Enter manda "${escapeHtml(cmdSearch.value)}" tal cual.</p>`;
    return;
  }
  for (const c of all) {
    const b = document.createElement("button");
    b.className = "w-full text-left bg-slate-700/60 active:bg-emerald-600 rounded-lg px-3 py-2";
    b.innerHTML =
      `<div class="flex items-baseline gap-2"><span class="text-sm font-mono text-emerald-300">${escapeHtml(c.cmd)}</span>` +
      `<span class="ml-auto text-[10px] text-slate-500 shrink-0">${escapeHtml(c.scope)}</span></div>` +
      (c.desc ? `<div class="text-[11px] text-slate-400 leading-tight line-clamp-2">${escapeHtml(c.desc)}</div>` : "");
    b.addEventListener("click", () => runCommand(c));
    cmdList.appendChild(b);
  }
}

document.getElementById("cmdBtn").addEventListener("click", async () => {
  cmdSearch.value = "";
  renderCommands();
  cmdModal.classList.remove("hidden");
  // Comandos propios (.claude/commands) y skills del proyecto y del usuario.
  try {
    const cwd = currentProject ? `?cwd=${encodeURIComponent(currentProject.path)}` : "";
    const data = await (await fetch(`/api/commands${cwd}`)).json();
    customCommands = data.commands || [];
    renderCommands();
  } catch { /* solo los del CLI */ }
});
cmdSearch.addEventListener("input", renderCommands);
cmdSearch.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const first = cmdList.querySelector("button");
  const typed = cmdSearch.value.trim();
  if (first) first.click();
  else if (typed) runCommand({ cmd: typed.startsWith("/") ? typed : "/" + typed });
});
document.getElementById("cmd-close").addEventListener("click", () => cmdModal.classList.add("hidden"));
cmdModal.addEventListener("click", (e) => { if (e.target === cmdModal) cmdModal.classList.add("hidden"); });

// --- Adjuntar archivos (fotos, capturas, etc.) -----------------------------
// Se suben a la PC y su ruta se escribe en el prompt: Claude los lee desde ahí.
const attachBtn = document.getElementById("attachBtn");
const attachInput = document.getElementById("attach-input");
attachBtn.addEventListener("click", () => attachInput.click());
attachInput.addEventListener("change", async () => {
  const files = [...attachInput.files];
  attachInput.value = "";
  if (!files.length) return;
  const prev = attachBtn.textContent;
  attachBtn.textContent = "⏳ Subiendo…";
  const paths = [];
  for (const f of files) {
    try {
      const r = await fetch(`/api/upload?name=${encodeURIComponent(f.name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: f,
      });
      const data = await r.json();
      if (data.path) paths.push(/\s/.test(data.path) ? `"${data.path}"` : data.path);
    } catch { /* sigue con el resto */ }
  }
  attachBtn.textContent = paths.length === files.length ? prev : `✗ ${files.length - paths.length} falló`;
  if (attachBtn.textContent !== prev) setTimeout(() => (attachBtn.textContent = prev), 2000);
  if (paths.length) {
    send({ type: "input", data: " " + paths.join(" ") + " " });
    term.focus();
  }
});

// --- Build detectado: ¿descargarlo en el celular? --------------------------
const buildModal = document.getElementById("build-modal");
const buildList = document.getElementById("build-list");
const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

function closeBuild() {
  buildModal.classList.add("hidden");
  send({ type: "build-ack" }); // no volver a ofrecerlo al reconectar
}

// En la app, los APK se descargan e instalan de forma nativa; lo demás (o en el
// navegador) se descarga normalmente.
function downloadBuild(b) {
  const url = new URL(b.url, location.href).href;
  if (window.CRNative && CRNative.installApk && /\.apk$/i.test(b.name)) CRNative.installApk(url, b.name);
  else if (window.CRNative && CRNative.openUrl) CRNative.openUrl(url);
  else location.href = url;
}

function showBuild(builds) {
  buildList.innerHTML = "";
  for (const b of builds) {
    const btn = document.createElement("button");
    btn.className = "w-full text-left bg-emerald-700 active:bg-emerald-600 rounded-lg px-3 py-2";
    btn.innerHTML = `<div class="text-sm font-semibold">⬇ Descargar ${escapeHtml(b.name)}</div>` +
      `<div class="text-[11px] text-emerald-100/80 break-all">${escapeHtml(b.rel)} · ${fmtSize(b.size)}</div>`;
    btn.addEventListener("click", () => { closeBuild(); downloadBuild(b); });
    buildList.appendChild(btn);
  }
  buildModal.classList.remove("hidden");
}
document.getElementById("build-no").addEventListener("click", closeBuild);

// --- Links, copiar y pegar -------------------------------------------------
// Vuelca el contenido actual de la terminal a texto plano. Claude corre en
// pantalla alternativa, así que el buffer activo son las filas visibles.
function terminalText() {
  const buf = term.buffer.active;
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    out.push(line ? line.translateToString(true) : "");
  }
  while (out.length && !out[out.length - 1].trim()) out.pop(); // recorta el final vacío
  return out.join("\n");
}

// Copia al portapapeles: puente nativo en la app, Clipboard API en el navegador.
async function copyToClipboard(text) {
  if (window.CRNative && CRNative.copy) { CRNative.copy(text); return true; }
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

// --- Links: escanea la pantalla y los lista (no toca el render de xterm) ----
const URL_RE = /\bhttps?:\/\/[^\s<>"'`()\[\]]+/gi;
const linksModal = document.getElementById("links-modal");
const linksList = document.getElementById("links-list");

document.getElementById("linksBtn").addEventListener("click", () => {
  const found = [...new Set(terminalText().match(URL_RE) || [])]
    .map((u) => u.replace(/[.,;:]+$/, "")); // limpia puntuación pegada al final
  linksList.innerHTML = "";
  if (!found.length) {
    linksList.innerHTML = '<p class="text-sm text-slate-400">No hay links en la pantalla.</p>';
  } else {
    for (const url of found) {
      const b = document.createElement("button");
      b.className = "w-full text-left bg-slate-700 active:bg-emerald-600 rounded-lg px-3 py-2 text-xs break-all";
      b.textContent = url;
      b.addEventListener("click", () => { openUrl(url); linksModal.classList.add("hidden"); });
      linksList.appendChild(b);
    }
  }
  linksModal.classList.remove("hidden");
});
document.getElementById("links-close").addEventListener("click", () => linksModal.classList.add("hidden"));
linksModal.addEventListener("click", (e) => { if (e.target === linksModal) linksModal.classList.add("hidden"); });

// --- Copiar: copia toda la pantalla de una ---------------------------------
const copyBtn = document.getElementById("copyBtn");
copyBtn.addEventListener("click", async () => {
  const ok = await copyToClipboard(terminalText());
  const prev = copyBtn.textContent;
  copyBtn.textContent = ok ? "✓ Copiado" : "✗ Error";
  setTimeout(() => (copyBtn.textContent = prev), 1500);
});

// --- Pegar: panel para revisar/editar antes de enviar ----------------------
const pasteModal = document.getElementById("paste-modal");
const pasteText = document.getElementById("paste-text");

// La app responde a requestPaste llamando aquí; con el panel abierto, precarga.
window.__crPaste = (text) => {
  if (text) pasteText.value = text;
};

document.getElementById("pasteBtn").addEventListener("click", () => {
  pasteText.value = "";
  pasteModal.classList.remove("hidden");
  pasteText.focus();
  // Precarga el portapapeles del sistema (nativo en la app, Clipboard API afuera).
  if (window.CRNative && CRNative.requestPaste) CRNative.requestPaste();
  else if (navigator.clipboard && navigator.clipboard.readText) {
    navigator.clipboard.readText().then((t) => { if (t && !pasteText.value) pasteText.value = t; }).catch(() => {});
  }
});
document.getElementById("paste-close").addEventListener("click", () => pasteModal.classList.add("hidden"));
pasteModal.addEventListener("click", (e) => { if (e.target === pasteModal) pasteModal.classList.add("hidden"); });
document.getElementById("paste-send").addEventListener("click", () => {
  const t = pasteText.value;
  pasteModal.classList.add("hidden");
  if (t) { send({ type: "input", data: t }); term.focus(); }
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

// La API devuelve utilization ya como porcentaje (0–100, igual que limits[].percent),
// así que solo se redondea. (Antes se multiplicaba ×100 si era ≤1, lo que hacía que
// un 1 % de uso se mostrara como 100 % → "0% libre" falso.)
const toPct = (u) => (u == null ? null : Math.round(u));

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
    // Si el servidor devolvió cache (stale por rate limit), refleja su antigüedad real.
    if (data.windows) { latestWindows = data.windows; lastUsageAt = data.stale ? data.cachedAt : Date.now(); }
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
setInterval(fetchUsage, 60000); // refresca métricas cada 60 s (evita el rate limit 429)
setInterval(() => {
  paintTimer();
  if (usageOpen()) renderUsageModal(); // refresca la cuenta regresiva del panel
}, 1000);
