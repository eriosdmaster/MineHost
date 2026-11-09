import { z } from "zod";
import { query } from "./db.js";

import { AppError } from "./errors.js";
import { localEnabled, localSupports, localCatalog, provisionLocal, removeLocal, power as localPower, command as localCommand, status as localStatus, logs as localLogs } from "./local.js";
export { AppError };

// Catálogo único usado pelo painel e pelo bot.
export const CATALOG = {
  java: { paper: "Paper", purpur: "Purpur", fabric: "Fabric", forge: "Forge", vanilla: "Vanilla" },
  bedrock: { vanilla: "Bedrock (oficial)", pocketmine: "PocketMine-MP", powernukkitx: "PowerNukkitX" }
};
// No modo local só aparece o que o driver sabe instalar.
const localOnly = () => localEnabled() && !pteroEnabled();
export const availableCatalog = () => (localOnly() ? localCatalog(CATALOG) : CATALOG);
export const defaultSoftware = ed => (localOnly() && ed === "bedrock" ? "powernukkitx" : DEFAULTS[ed].software);
export const controlEnabled = () => clientEnabled() || localEnabled();
export const DEFAULTS = {
  java: { software: "paper", ram_mb: 2048, disk_mb: 5120 },
  bedrock: { software: "vanilla", ram_mb: 1024, disk_mb: 5120 }
};

const MAX_SERVERS = () => Number(process.env.MAX_SERVERS_PER_USER || 3);
const ACTIVE_STATES = "('pending','approved','provisioning','active')";

export const serverSchema = z.object({
  name: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_-]+$/),
  edition: z.enum(["java", "bedrock"]),
  software: z.string().trim().toLowerCase().min(2).max(40),
  version: z.string().trim().regex(/^[0-9A-Za-z.\-]{1,20}$/).optional().or(z.literal("")),
  ram_mb: z.number().int().min(512).max(16384),
  disk_mb: z.number().int().min(1024).max(102400)
}).superRefine((d, ctx) => {
  if (!CATALOG[d.edition]?.[d.software]) {
    ctx.addIssue({ code: "custom", message: `Software inválido para ${d.edition}. Opções: ${Object.keys(CATALOG[d.edition] || {}).join(", ")}` });
  }
});

// ---------- Pterodactyl (API oficial de Application) ----------
export const pteroEnabled = () =>
  !!(process.env.PTERO_URL && process.env.PTERO_API_KEY && process.env.PTERO_USER_ID && process.env.PTERO_LOCATION_ID);

function eggRef(edition, software) {
  try { return JSON.parse(process.env.PTERO_EGGS || "{}")[`${edition}:${software}`] || null; }
  catch { return null; }
}

async function ptero(path, options = {}) {
  const r = await fetch(`${process.env.PTERO_URL.replace(/\/+$/, "")}/api/application${path}`, {
    ...options,
    signal: AbortSignal.timeout(20000),
    headers: {
      Authorization: `Bearer ${process.env.PTERO_API_KEY}`,
      Accept: "Application/vnd.pterodactyl.v1+json",
      "Content-Type": "application/json"
    }
  });
  if (!r.ok && !(options.method === "DELETE" && r.status === 404)) {
    throw new Error(`Pterodactyl HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
  return r.status === 204 || r.status === 404 ? null : r.json();
}

async function createOnPtero(s) {
  const ref = eggRef(s.edition, s.software);
  if (!ref) throw new Error(`Egg não configurado para ${s.edition}:${s.software} (PTERO_EGGS)`);
  const egg = (await ptero(`/nests/${ref.nest}/eggs/${ref.egg}?include=variables`)).attributes;
  const environment = {};
  for (const v of egg.relationships?.variables?.data || []) environment[v.attributes.env_variable] = v.attributes.default_value;
  if (s.version) for (const k of ["MINECRAFT_VERSION", "BEDROCK_VERSION", "VERSION"]) if (k in environment) environment[k] = s.version;

  const created = await ptero("/servers", {
    method: "POST",
    body: JSON.stringify({
      name: `${s.name}-${s.id}`,
      user: Number(process.env.PTERO_USER_ID),
      egg: Number(ref.egg),
      docker_image: egg.docker_image || Object.values(egg.docker_images || {})[0],
      startup: egg.startup,
      environment,
      limits: { memory: s.ram_mb, swap: 0, disk: s.disk_mb, io: 500, cpu: Number(process.env.PTERO_CPU_LIMIT || 0) },
      feature_limits: { databases: 0, allocations: 1, backups: 2 },
      deploy: { locations: [Number(process.env.PTERO_LOCATION_ID)], dedicated_ip: false, port_range: [] },
      start_on_completion: true
    })
  });
  const id = String(created.attributes.id);
  let address = null;
  try {
    const full = await ptero(`/servers/${id}?include=allocations`);
    const a = full.attributes.relationships?.allocations?.data?.[0]?.attributes;
    if (a) address = `${process.env.PTERO_PUBLIC_HOST || a.ip_alias || a.ip}:${a.port}`;
  } catch { /* endereço é opcional */ }
  return { id, address };
}

const useLocal = r => localEnabled() && localSupports(r.edition, r.software) && !(pteroEnabled() && eggRef(r.edition, r.software));

// Provisiona uma solicitação já gravada. Nunca lança: grava active/failed.
export async function provisionRequest(id) {
  const row = (await query("SELECT * FROM server_requests WHERE id=$1", [id])).rows[0];
  if (!row) return null;
  try {
    await query("UPDATE server_requests SET status='provisioning',error=NULL WHERE id=$1", [id]);
    if (useLocal(row)) {
      const address = await provisionLocal(row);
      return (await query("UPDATE server_requests SET status='active',connect_address=$2,error=NULL WHERE id=$1 RETURNING *", [id, address])).rows[0];
    }
    if (!pteroEnabled()) throw new Error("Nenhum provedor configurado");
    const r = await createOnPtero(row);
    return (await query(
      "UPDATE server_requests SET status='active',external_server_id=$2,connect_address=$3,error=NULL WHERE id=$1 RETURNING *",
      [id, r.id, r.address])).rows[0];
  } catch (e) {
    console.error(`Provisionamento #${id} falhou:`, e.message);
    return (await query("UPDATE server_requests SET status='failed',error=$2,port=NULL WHERE id=$1 RETURNING *", [id, e.message.slice(0, 400)])).rows[0];
  }
}

// ---------- Serviço compartilhado (painel + bot Matrix) ----------
export async function createServer(user, input, { source = "web", onDone } = {}) {
  const parsed = serverSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(400, parsed.error.issues.find(i => i.code === "custom")?.message ||
      "Dados inválidos. Nome: 3-32 (letras, números, _ ou -); RAM: 512-16384 MB; disco: 1024-102400 MB.");
  }
  const d = parsed.data;
  const count = await query(`SELECT COUNT(*)::int n FROM server_requests WHERE user_id=$1 AND status IN ${ACTIVE_STATES}`, [user.id]);
  if (count.rows[0].n >= MAX_SERVERS()) throw new AppError(429, `Limite de ${MAX_SERVERS()} servidores por usuário`);
  const dup = await query("SELECT 1 FROM server_requests WHERE user_id=$1 AND lower(name)=lower($2) AND status IN ('pending','approved','provisioning','active','failed')", [user.id, d.name]);
  if (dup.rowCount) throw new AppError(409, "Você já tem um servidor com esse nome");

  if (localOnly() && !localSupports(d.edition, d.software)) {
    throw new AppError(400, `Software indisponível aqui. Opções: ${Object.keys(availableCatalog()[d.edition]).join(", ")}`);
  }
  const auto = (pteroEnabled() && !!eggRef(d.edition, d.software)) || (localEnabled() && localSupports(d.edition, d.software));
  const row = (await query(
    `INSERT INTO server_requests(user_id,name,edition,software,version,ram_mb,disk_mb,status,source)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [user.id, d.name, d.edition, d.software, d.version || null, d.ram_mb, d.disk_mb, auto ? "provisioning" : "pending", source]
  )).rows[0];
  await query("INSERT INTO audit_logs(actor_id,action,details) VALUES($1,'server.request.created',$2)",
    [user.id, JSON.stringify({ server_id: row.id, source, auto })]);

  if (auto) provisionRequest(row.id).then(r => onDone?.(r)).catch(e => console.error(e));
  return { server: row, auto };
}

export async function deleteServer(user, id) {
  const r = await query("SELECT * FROM server_requests WHERE id=$1", [id]);
  const s = r.rows[0];
  if (!s || (String(s.user_id) !== String(user.id) && user.role !== "admin")) throw new AppError(404, "Servidor não encontrado");
  if (s.driver === "local") await removeLocal(s);
  else if (s.external_server_id && pteroEnabled()) {
    try { await ptero(`/servers/${s.external_server_id}`, { method: "DELETE" }); }
    catch (e) { throw new AppError(502, `Falha ao remover no provedor: ${e.message}`); }
  }
  await query("DELETE FROM server_requests WHERE id=$1", [id]);
  await query("INSERT INTO audit_logs(actor_id,action,details) VALUES($1,'server.deleted',$2)", [user.id, JSON.stringify({ server_id: s.id, name: s.name })]);
  return s;
}

// ---------- Pterodactyl Client API (chave ptlc_): só controla servidores que já existem ----------
export const clientEnabled = () => !!(process.env.PTERO_URL && process.env.PTERO_CLIENT_KEY);

async function pclient(path, options = {}) {
  const r = await fetch(`${process.env.PTERO_URL.replace(/\/+$/, "")}/api/client${path}`, {
    ...options,
    signal: AbortSignal.timeout(20000),
    headers: {
      Authorization: `Bearer ${process.env.PTERO_CLIENT_KEY}`,
      Accept: "Application/vnd.pterodactyl.v1+json",
      "Content-Type": "application/json"
    }
  });
  if (!r.ok) throw new AppError(502, `O provedor respondeu HTTP ${r.status}`);
  return r.status === 204 ? null : r.json();
}

// Admin: liga uma solicitação a um servidor que ele já criou no painel da hospedagem.
export async function linkServer(requestId, identifier) {
  if (!clientEnabled()) throw new AppError(400, "PTERO_CLIENT_KEY não configurada");
  if (!/^[0-9a-f-]{8,36}$/i.test(identifier || "")) throw new AppError(400, "Identificador inválido (os 8 caracteres da URL do servidor)");
  if ((await query("SELECT 1 FROM server_requests WHERE external_server_id=$1 AND id<>$2", [identifier, requestId])).rowCount) {
    throw new AppError(409, "Esse servidor já está vinculado a outra solicitação");
  }
  const attrs = (await pclient(`/servers/${identifier}`)).attributes;
  const list = (attrs.relationships?.allocations?.data || []).map(x => x.attributes);
  const a = list.find(x => x.is_default) || list[0];
  const address = a ? `${process.env.PTERO_PUBLIC_HOST || a.ip_alias || a.ip}:${a.port}` : null;
  const r = await query("UPDATE server_requests SET status='active',external_server_id=$2,connect_address=$3,error=NULL WHERE id=$1 RETURNING *", [requestId, identifier, address]);
  if (!r.rowCount) throw new AppError(404, "Solicitação não encontrada");
  await query("INSERT INTO audit_logs(action,details) VALUES('server.linked',$1)", [JSON.stringify({ request_id: requestId, identifier })]);
  return r.rows[0];
}

async function owned(user, id) {
  const s = (await query("SELECT * FROM server_requests WHERE id=$1 AND user_id=$2", [id, user.id])).rows[0];
  if (!s) throw new AppError(404, "Servidor não encontrado");
  const ready = s.status === "active" && (s.driver === "local" || (clientEnabled() && s.external_server_id));
  if (!ready) throw new AppError(409, "Este servidor ainda não está pronto (criado/vinculado)");
  return s;
}
export async function powerServer(user, id, action) {
  if (!["start", "stop", "restart", "kill"].includes(action)) throw new AppError(400, "Ação inválida");
  const s = await owned(user, id);
  if (s.driver === "local") { await localPower(s, action); return s; }
  await pclient(`/servers/${s.external_server_id}/power`, { method: "POST", body: JSON.stringify({ signal: action }) });
  return s;
}
export async function commandServer(user, id, command) {
  const c = String(command || "").trim();
  if (!c || c.length > 200) throw new AppError(400, "Comando vazio ou maior que 200 caracteres");
  const s = await owned(user, id);
  if (s.driver === "local") { await localCommand(s, c); return s; }
  await pclient(`/servers/${s.external_server_id}/command`, { method: "POST", body: JSON.stringify({ command: c }) });
  return s;
}
export async function serverStatus(user, id) {
  const s = await owned(user, id);
  if (s.driver === "local") return { server: s, ...(await localStatus(s)) };
  const a = (await pclient(`/servers/${s.external_server_id}/resources`)).attributes;
  return { server: s, state: a.current_state, memory_mb: Math.round((a.resources?.memory_bytes || 0) / 1048576), cpu: Math.round(a.resources?.cpu_absolute || 0) };
}

export async function serverLogs(user, id, n = 15) {
  const s = await owned(user, id);
  if (s.driver !== "local") throw new AppError(400, "Logs só estão disponíveis em servidores criados pelo modo local");
  return localLogs(s, n);
}
