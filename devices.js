// Celulares vinculados: `npm run devices` los lista; `node devices.js revoke <id>`
// desvincula uno (el servidor lo echa al instante). `--json` para la bandeja.
import { listDevices, revokeDevice } from "./security.js";

const [cmd, id] = process.argv.slice(2).filter((a) => a !== "--json");
const json = process.argv.includes("--json");

if (cmd === "revoke") {
  const ok = !!id && revokeDevice(id);
  if (json) console.log(JSON.stringify({ ok }));
  else console.log(ok ? `Desvinculado: ${id}` : `No existe el celular ${id ?? "(falta el id)"}`);
  process.exit(ok ? 0 : 1);
}

const list = listDevices();
if (json) console.log(JSON.stringify(list));
else if (!list.length) console.log("No hay celulares vinculados.");
else for (const d of list) console.log(`${d.id}\t${d.created ? d.created.slice(0, 10) : "—"}\t${d.name}`);
