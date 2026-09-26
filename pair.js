// Genera un código de vinculación para la app (vale 5 minutos, un solo uso).
// Uso: `npm run pair` (o `node pair.js --quiet` para imprimir solo el código).
import { newPairingCode } from "./security.js";

const code = newPairingCode(5);
if (process.argv.includes("--quiet")) console.log(code);
else console.log(`Código de vinculación: ${code.slice(0, 3)} ${code.slice(3)}\nIngresalo en la app (vale 5 minutos).`);
