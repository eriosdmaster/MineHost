import { query } from "./db.js";
import { availableCatalog, defaultSoftware, DEFAULTS, AppError, createServer, deleteServer, powerServer, commandServer, serverStatus, serverLogs } from "./provision.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hs = () => (process.env.MATRIX_HOMESERVER || "https://matrix.org").replace(/\/+$/, "");
const token = () => process.env.MATRIX_ACCESS_TOKEN;
const POLL = () => Number(process.env.MATRIX_POLL_TIMEOUT_MS || 30000);

async function mx(path, options = {}, timeout = 20000) {
  const r = await fetch(`${hs()}/_matrix/client/v3${path}`, {
    ...options,
    signal: AbortSignal.timeout(timeout),
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", ...(options.headers || {}) }
  });
  if (!r.ok) throw new Error(`Matrix HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}

const send = (room, body) => mx(`/rooms/${encodeURIComponent(room)}/send/m.room.message/${Date.now()}${Math.random().toString(16).slice(2)}`,
  { method: "PUT", body: JSON.stringify({ msgtype: "m.notice", body }) });

const ALIASES = { help: "ajuda", servers: "servidores", create: "criar", delete: "excluir", list: "servidores", start: "iniciar", stop: "parar", restart: "reiniciar", kill: "matar", command: "cmd", logs: "log" };
const cooldown = new Map();      // sender -> último !criar
const encWarned = new Map();     // room -> última vez que avisamos sobre E2EE

const parseMb = v => {
  const m = /^(\d+)\s*(g|gb|m|mb)?$/i.exec(v || "");
  return m ? Number(m[1]) * (/^g/i.test(m[2] || "") ? 1024 : 1) : null;
};
const fmt = s => `#${s.id} ${s.name} — ${s.edition}/${s.software}${s.version ? " " + s.version : ""} — ${s.status}${s.connect_address ? " — " + s.connect_address : ""}`;
const userOf = async sender => (await query("SELECT id,email,role FROM users WHERE matrix_user=$1", [sender])).rows[0];
const NEED_LINK = "Sua conta ainda não está vinculada. No painel, gere um código em Matrix e envie: !link CODIGO";

const power = (action, label) => async ({ room, sender, args }) => {
  const u = await userOf(sender);
  if (!u) return send(room, NEED_LINK);
  const s = await powerServer(u, Number(args[0]) || 0, action);
  await send(room, `${label} #${s.id} ${s.name}.`);
};

const commands = {
  iniciar: power("start", "▶️ Iniciando"), parar: power("stop", "⏹️ Parando"),
  reiniciar: power("restart", "🔄 Reiniciando"), matar: power("kill", "☠️ Forçando parada de"),

  async ajuda({ room }) {
    await send(room, [
      "MineHost Bot — comandos:",
      "!link CODIGO — vincula sua conta do painel",
      "!criar <nome> <java|bedrock> [software] [ram] [disco] — cria um servidor",
      "   ex.: !criar survival java paper 2G 10G   |   !criar mundo bedrock",
      "!servidores — lista seus servidores",
      "!info <id> — detalhes de um servidor",
      "!iniciar | !parar | !reiniciar | !matar <id> — energia do servidor",
      "!status <id> — estado e RAM",
      "!log <id> — últimas linhas do console (modo local)",
      '!cmd <id> <comando> — roda um comando no console (ex.: !cmd 3 say oi)',
      "!excluir <id> confirmar — remove um servidor",
      `Java: ${Object.keys(availableCatalog().java).join(", ")}`,
      `Bedrock: ${Object.keys(availableCatalog().bedrock).join(", ")}`
    ].join("\n"));
  },

  async link({ room, sender, args }) {
    if (!args[0]) return send(room, "Use: !link CODIGO");
    const r = await query(
      "UPDATE users SET matrix_user=$1,matrix_link_code=NULL,matrix_link_expires=NULL WHERE matrix_link_code=$2 AND matrix_link_expires>NOW() RETURNING email",
      [sender, args[0].toUpperCase()]);
    await send(room, r.rowCount ? `Conta ${r.rows[0].email} vinculada. Envie !criar para começar.` : "Código inválido ou expirado. Gere outro no painel.");
  },

  async servidores({ room, sender }) {
    const u = await userOf(sender);
    if (!u) return send(room, NEED_LINK);
    const s = await query("SELECT * FROM server_requests WHERE user_id=$1 ORDER BY id DESC LIMIT 15", [u.id]);
    await send(room, s.rowCount ? s.rows.map(fmt).join("\n") : "Você ainda não tem servidores. Use !criar.");
  },

  async info({ room, sender, args }) {
    const u = await userOf(sender);
    if (!u) return send(room, NEED_LINK);
    const s = (await query("SELECT * FROM server_requests WHERE id=$1 AND user_id=$2", [Number(args[0]) || 0, u.id])).rows[0];
    if (!s) return send(room, "Servidor não encontrado. Use !servidores para ver os IDs.");
    await send(room, [fmt(s), `RAM ${s.ram_mb} MB · Disco ${s.disk_mb} MB`, s.error ? `Erro: ${s.error}` : null].filter(Boolean).join("\n"));
  },

  async criar({ room, sender, args }) {
    const u = await userOf(sender);
    if (!u) return send(room, NEED_LINK);
    const [name, edition, ...rest] = args;
    if (!name || !availableCatalog()[edition?.toLowerCase()]) return send(room, "Use: !criar <nome> <java|bedrock> [software] [ram] [disco]\nEx.: !criar survival java paper 2G 10G");
    const ed = edition.toLowerCase();
    const nums = rest.filter(x => parseMb(x) !== null).map(parseMb);
    const software = rest.find(x => parseMb(x) === null) || defaultSoftware(ed);
    if (Date.now() - (cooldown.get(sender) || 0) < 10000) return send(room, "Aguarde alguns segundos antes de criar outro servidor.");
    cooldown.set(sender, Date.now());

    const { server, auto } = await createServer(u, {
      name, edition: ed, software, ram_mb: nums[0] ?? DEFAULTS[ed].ram_mb, disk_mb: nums[1] ?? DEFAULTS[ed].disk_mb
    }, {
      source: "matrix",
      onDone: r => send(room, r.status === "active"
        ? `✅ Servidor pronto!\n${fmt(r)}`
        : `❌ Não foi possível criar #${r.id}: ${r.error}\nUm administrador pode tentar novamente.`).catch(e => console.error(e.message))
    });
    await send(room, auto
      ? `⏳ Criando #${server.id} ${server.name} (${server.edition}/${server.software}, ${server.ram_mb} MB)… aviso quando terminar.`
      : `📝 Solicitação #${server.id} registrada. O administrador vai criar e vincular seu servidor (status Ativo no painel).`);
  },

  async status({ room, sender, args }) {
    const u = await userOf(sender);
    if (!u) return send(room, NEED_LINK);
    const r = await serverStatus(u, Number(args[0]) || 0);
    await send(room, `#${r.server.id} ${r.server.name}: ${r.state} · RAM ${r.memory_mb} MB${r.cpu != null ? ` · CPU ${r.cpu}%` : ""}`);
  },

  async log({ room, sender, args }) {
    const u = await userOf(sender);
    if (!u) return send(room, NEED_LINK);
    const lines = await serverLogs(u, Number(args[0]) || 0, 15);
    await send(room, lines.length ? lines.join("\n") : "Sem saída ainda.");
  },

  async cmd({ room, sender, args }) {
    const u = await userOf(sender);
    if (!u) return send(room, NEED_LINK);
    const s = await commandServer(u, Number(args[0]) || 0, args.slice(1).join(" "));
    await send(room, `➡️ Comando enviado ao #${s.id} ${s.name}.`);
  },

  async excluir({ room, sender, args }) {
    const u = await userOf(sender);
    if (!u) return send(room, NEED_LINK);
    const id = Number(args[0]);
    if (!id) return send(room, "Use: !excluir <id> confirmar");
    if (args[1]?.toLowerCase() !== "confirmar") return send(room, `Isso apaga o servidor #${id} para sempre. Para confirmar: !excluir ${id} confirmar`);
    const s = await deleteServer(u, id);
    await send(room, `🗑️ Servidor #${s.id} (${s.name}) removido.`);
  }
};

async function handleEvent(roomId, event) {
  if (event.sender === process.env.MATRIX_BOT_USER) return;

  if (event.type === "m.room.encrypted") {
    if (Date.now() - (encWarned.get(roomId) || 0) > 600000) {
      encWarned.set(roomId, Date.now());
      await send(roomId, "Esta sala é criptografada e eu não consigo ler mensagens aqui. Crie uma sala SEM criptografia e me convide.");
    }
    return;
  }
  if (event.type !== "m.room.message" || event.content?.msgtype !== "m.text" || event.content["m.relates_to"]?.rel_type === "m.replace") return;
  const body = event.content.body;
  if (typeof body !== "string" || !body.startsWith("!")) return;

  const [raw, ...args] = body.trim().split(/\s+/);
  const name = raw.slice(1).toLowerCase();
  const fn = commands[ALIASES[name] || name];
  if (!fn) return;
  try {
    await fn({ room: roomId, sender: event.sender, args });
  } catch (e) {
    if (!(e instanceof AppError)) console.error("Erro no comando Matrix:", e);
    await send(roomId, e instanceof AppError ? `⚠️ ${e.message}` : "Ocorreu um erro ao processar o comando.").catch(() => {});
  }
}

const FILTER = JSON.stringify({
  presence: { not_types: ["*"] }, account_data: { not_types: ["*"] },
  room: { ephemeral: { not_types: ["*"] }, account_data: { not_types: ["*"] }, state: { lazy_load_members: true, types: [] }, timeline: { types: ["m.room.message", "m.room.encrypted"] } }
});

export async function startMatrixBot() {
  if (!token()) return console.log("Matrix bot desativado: MATRIX_ACCESS_TOKEN não configurado.");
  console.log("Matrix bot iniciado (somente salas sem E2EE).");
  let since;
  while (true) {
    try {
      const params = new URLSearchParams({ timeout: since ? String(POLL()) : "0", filter: FILTER, ...(since ? { since } : {}) });
      const data = await mx(`/sync?${params}`, {}, POLL() + 30000);
      const first = !since;                       // 1º sync: só descarta o histórico antigo
      since = data.next_batch;

      for (const roomId of Object.keys(data.rooms?.invite || {})) {   // aceita convites automaticamente
        mx(`/join/${encodeURIComponent(roomId)}`, { method: "POST", body: "{}" }).catch(e => console.error("join:", e.message));
      }
      if (first) continue;
      for (const [roomId, room] of Object.entries(data.rooms?.join || {})) {
        for (const event of room.timeline?.events || []) await handleEvent(roomId, event);
      }
    } catch (e) {
      console.error("Matrix sync:", e.message);
      await sleep(5000);
    }
  }
}
