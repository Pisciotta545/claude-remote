// Notificaciones push (FCM HTTP v1) sin dependencias externas: el JWT se firma
// con la private key del service account usando el `crypto` nativo de Node.
import { writeFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { createSign } from "crypto";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Credencial para ENVIAR (distinta del google-services.json, que es para recibir):
// la completa del proyecto (solo en la PC del autor) o push-sender.json, una
// cuenta que SOLO puede mandar notificaciones y viaja en el instalador.
const SA_PATH = process.env.FIREBASE_SA_PATH ||
  ["firebase-service-account.json", "push-sender.json"].map((f) => join(__dirname, f)).find(existsSync) ||
  join(__dirname, "firebase-service-account.json");
const TOKENS_PATH = process.env.PUSH_TOKENS_PATH || join(__dirname, "push-tokens.json");

let sa = null;
try {
  if (existsSync(SA_PATH)) sa = JSON.parse(readFileSync(SA_PATH, "utf8"));
} catch (e) {
  console.error("[push] no se pudo leer el service account:", e.message);
}

export const pushEnabled = () => !!sa;
export const pushCredential = () => (sa ? basename(SA_PATH) : null);

// --- Tokens de dispositivos (persisten entre reinicios) --------------------
let tokens = new Set();
try {
  if (existsSync(TOKENS_PATH)) tokens = new Set(JSON.parse(readFileSync(TOKENS_PATH, "utf8")));
} catch {
  /* archivo nuevo o corrupto: se arranca vacío */
}
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    writeFile(TOKENS_PATH, JSON.stringify([...tokens])).catch(() => {});
  }, 200);
}
export function addToken(t) {
  if (t && !tokens.has(t)) { tokens.add(t); persist(); }
}
export function removeToken(t) {
  if (tokens.delete(t)) persist();
}

// --- OAuth: JWT RS256 firmado con la private key → access token ------------
const b64url = (buf) => Buffer.from(buf).toString("base64url");
let cached = { value: null, exp: 0 };
async function accessToken() {
  if (cached.value && Date.now() < cached.exp - 60_000) return cached.value;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${b64url(signer.sign(sa.private_key))}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`oauth ${res.status}: ${await res.text()}`);
  const j = await res.json();
  cached = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cached.value;
}

// --- Envío a todos los dispositivos registrados ----------------------------
export async function sendPush({ title, body, data }) {
  if (!sa || tokens.size === 0) return;
  let bearer;
  try {
    bearer = await accessToken();
  } catch (e) {
    console.error("[push] no se pudo obtener el access token:", e.message);
    return;
  }
  const url = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;
  await Promise.all([...tokens].map(async (device) => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token: device,
            notification: { title, body },
            data: data || {},
            android: {
              priority: "high",
              notification: { channel_id: "claude", sound: "default" },
            },
          },
        }),
      });
      if (!res.ok) {
        const txt = await res.text();
        // Token dado de baja o inválido: se descarta para no reintentar siempre.
        if (/UNREGISTERED|INVALID_ARGUMENT|NOT_FOUND/.test(txt)) removeToken(device);
        else console.error(`[push] FCM ${res.status}: ${txt}`);
      }
    } catch (e) {
      console.error("[push] envío falló:", e.message);
    }
  }));
}
