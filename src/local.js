// Driver "local": roda os servidores Minecraft como processos filhos desta mesma máquina/container.
import { spawn, execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import path from "node:path";
import { query } from "./db.js";
import { AppError } from "./errors.js";

const run = promisify(execFile);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = { "User-Agent": "Mozilla/5.0 minehost-panel" };
const DATA = () => path.resolve(process.env.DATA_DIR || "./data");
const dirOf = id => path.join(DATA(), "servers", String(id));
const K = row => String(row.id);

export const localEnabled = () => process.env.LOCAL_SERVERS === "true";
const SUPPORTED = { java: ["paper", "purpur", "fabric", "vanilla"], bedrock: ["powernukkitx", "vanilla"] };
export const localSupports = (ed, sw) => !!SUPPORTED[ed]?.includes(sw);
export const localCatalog = catalog => Object.fromEntries(Object.entries(SUPPORTED).map(([ed, list]) =>
  [ed, Object.fromEntries(list.map(k => [k, catalog[ed][k]]))]));
const isBds = r => r.edition === "bedrock" && r.software === "vanilla";

const procs = new Map();   // id -> { proc, state, log[], ram, stopping, exited }

// ---------- downloads ----------
async function getJson(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${new URL(url).host}`);
  return r.json();
}
async function download(url, dest) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(900000) });
  if (!r.ok || !r.body) throw new Error(`Download falhou (HTTP ${r.status}) em ${new URL(url).host}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(dest));
}
const newest = list => list.filter(v => /^\d+(\.\d+)+$/.test(v))
  .sort((a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0); return 0; })[0];

async function jarUrl(row) {
  const override = process.env[`MC_URL_${row.edition}_${row.software}`.toUpperCase()];   // ex.: MC_URL_JAVA_PAPER
  if (override) return override;
  const v = row.version;
  switch (row.software) {
    case "paper": {
      const ver = v || newest(Object.values((await getJson("https://fill.papermc.io/v3/projects/paper")).versions).flat());
      return (await getJson(`https://fill.papermc.io/v3/projects/paper/versions/${ver}/builds/latest`)).downloads["server:default"].url;
    }
    case "purpur": {
      const ver = v || newest((await getJson("https://api.purpurmc.org/v2/purpur")).versions);
      return `https://api.purpurmc.org/v2/purpur/${ver}/latest/download`;
    }
    case "fabric": {
      const game = v || (await getJson("https://meta.fabricmc.net/v2/versions/game")).find(x => x.stable).version;
      const loader = (await getJson("https://meta.fabricmc.net/v2/versions/loader")).find(x => x.stable).version;
      const inst = (await getJson("https://meta.fabricmc.net/v2/versions/installer")).find(x => x.stable).version;
      return `https://meta.fabricmc.net/v2/versions/loader/${game}/${loader}/${inst}/server/jar`;
    }
    case "vanilla": {
      const m = await getJson("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
      const e = m.versions.find(x => x.id === (v || m.latest.release));
      if (!e) throw new Error(`Versão ${v} não encontrada`);
      return (await getJson(e.url)).downloads.server.url;
    }
    case "powernukkitx": {
      const rel = await getJson("https://api.github.com/repos/PowerNukkitX/PowerNukkitX/releases/latest");
      const jar = (rel.assets || []).filter(a => /\.jar$/i.test(a.name) && !/sources|javadoc/i.test(a.name)).sort((a, b) => b.size - a.size)[0];
      if (!jar) throw new Error("Release do PowerNukkitX sem .jar (defina MC_URL_BEDROCK_POWERNUKKITX)");
      return jar.browser_download_url;
    }
  }
  throw new Error("Software não suportado no modo local");
}

async function bdsUrl(version) {
  const o = process.env.MC_URL_BEDROCK_VANILLA; if (o) return o;
  const d = await getJson("https://net-secondary.web.minecraft-services.net/api/v1.0/download/links");
  const url = d.result.links.find(l => l.downloadType === "serverBedrockLinux")?.downloadUrl;
  if (!url) throw new Error("Link do Bedrock Server não encontrado");
  return version ? url.replace(/bedrock-server-[\d.]+\.zip/, `bedrock-server-${version}.zip`) : url;
}

// ---------- Java ----------
let javaP;
export function ensureJava() {
  javaP ??= (async () => {
    try {
      const { stderr } = await run("java", ["-version"]);
      if (Number(/version "(\d+)/.exec(stderr)?.[1]) >= 21) return "java";
    } catch { /* sem java no PATH */ }
    const home = path.join(DATA(), "jre"), bin = path.join(home, "bin", "java");
    if (existsSync(bin)) return bin;
    await mkdir(home, { recursive: true });
    const tgz = path.join(DATA(), "jre.tar.gz");
    await download(`https://api.adoptium.net/v3/binary/latest/21/ga/linux/${process.arch === "arm64" ? "aarch64" : "x64"}/jre/hotspot/normal/eclipse`, tgz);
    await run("tar", ["-xzf", tgz, "-C", home, "--strip-components=1"]);
    await rm(tgz, { force: true });
    return bin;
  })().catch(e => { javaP = undefined; throw e; });
  return javaP;
}

// ---------- portas ----------
const parsePorts = v => {
  const out = [];
  for (const part of String(v || "").split(",")) {
    const m = /^\s*(\d+)(?:-(\d+))?\s*$/.exec(part);
    if (m) for (let p = +m[1]; p <= +(m[2] || m[1]); p++) out.push(p);
  }
  return out;
};
let portLock = Promise.resolve();
const allocPort = row => (portLock = portLock.catch(() => {}).then(async () => {
  if (row.port) return row.port;
  const bedrock = row.edition === "bedrock";
  const pool = parsePorts(process.env[bedrock ? "MC_BEDROCK_PORTS" : "MC_JAVA_PORTS"]);
  const used = new Set((await query("SELECT port FROM server_requests WHERE port IS NOT NULL")).rows.map(r => r.port));
  const web = Number(process.env.PORT || process.env.SERVER_PORT || 0);
  const port = pool.find(p => !used.has(p) && p !== web);
  if (!port) throw new Error(`Sem porta livre. Libere mais portas na hospedagem e liste em ${bedrock ? "MC_BEDROCK_PORTS" : "MC_JAVA_PORTS"}`);
  await query("UPDATE server_requests SET port=$2,driver='local' WHERE id=$1", [row.id, port]);
  return port;
}));

const host = () => process.env.MC_PUBLIC_HOST || (() => { try { return new URL(process.env.PUBLIC_URL).hostname; } catch { return "localhost"; } })();

// ---------- instalar ----------
async function install(row, dir, port) {
  await mkdir(dir, { recursive: true });
  if (isBds(row)) {
    if (process.arch !== "x64") throw new Error("O Bedrock oficial só roda em x64; use PowerNukkitX");
    const zip = path.join(dir, "bds.zip");
    await download(await bdsUrl(row.version), zip);
    const { default: AdmZip } = await import("adm-zip");
    new AdmZip(zip).extractAllTo(dir, true);
    await rm(zip, { force: true });
    await chmod(path.join(dir, "bedrock_server"), 0o755);
    await writeFile(path.join(dir, "server.properties"), `server-name=${row.name}\nserver-port=${port}\nserver-portv6=${40000 + (Number(row.id) % 20000)}\n`);
    return;
  }
  await download(await jarUrl(row), path.join(dir, "server.jar"));
  await writeFile(path.join(dir, "server.properties"), `server-port=${port}\nmotd=${row.name}\n`);
  if (row.edition === "java") {
    if (process.env.ACCEPT_MINECRAFT_EULA !== "true") throw new Error("Defina ACCEPT_MINECRAFT_EULA=true no .env (aceita https://aka.ms/MinecraftEULA)");
    await writeFile(path.join(dir, "eula.txt"), "eula=true\n");
  }
}

export async function provisionLocal(row) {
  const port = await allocPort(row);
  await install(row, dirOf(row.id), port);
  await start({ ...row, port });
  return `${host()}:${port}`;
}

// ---------- processo ----------
const READY = /Done \(|Server started\.|Listening on|Started Server/i;
const runningRam = () => [...procs.values()].reduce((t, e) => t + (e.state !== "stopped" ? e.ram : 0), 0);

export async function start(row) {
  const cur = procs.get(K(row));
  if (cur && cur.state !== "stopped") throw new AppError(409, "O servidor já está em execução");
  const cap = Number(process.env.LOCAL_TOTAL_RAM_MB || 0);
  if (cap && runningRam() + row.ram_mb > cap) throw new AppError(409, `Sem RAM livre no host (${cap} MB no total). Pare outro servidor.`);
  const dir = dirOf(row.id);
  let cmd, args, env = { ...process.env };
  if (isBds(row)) { cmd = path.join(dir, "bedrock_server"); args = []; env.LD_LIBRARY_PATH = dir; }
  else { cmd = await ensureJava(); args = [`-Xmx${Math.floor(row.ram_mb * 0.85)}M`, "-Dfile.encoding=UTF-8", "-jar", "server.jar", "nogui"]; }

  const e = { state: "starting", log: [], ram: row.ram_mb, stopping: false };
  e.proc = spawn(cmd, args, { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
  e.exited = new Promise(res => e.proc.on("close", res));
  const push = buf => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      e.log.push(line.slice(0, 300)); if (e.log.length > 200) e.log.shift();
      if (e.state === "starting" && READY.test(line)) e.state = "running";
    }
  };
  e.proc.stdout.on("data", push); e.proc.stderr.on("data", push);
  e.proc.stdin.on("error", () => {});
  e.proc.on("error", err => { push(`Erro ao iniciar: ${err.message}`); e.state = "stopped"; });
  e.proc.on("close", () => { e.state = "stopped"; });
  procs.set(K(row), e);
  await query("UPDATE server_requests SET autostart=TRUE WHERE id=$1", [row.id]);
}

async function stopProc(row, { remember = true } = {}) {
  const e = procs.get(K(row));
  if (!e || e.state === "stopped") throw new AppError(409, "O servidor já está parado");
  e.stopping = true; e.state = "stopping";
  e.proc.stdin.write("stop\n");
  setTimeout(() => e.state !== "stopped" && e.proc.kill("SIGKILL"), 30000).unref();
  if (remember) await query("UPDATE server_requests SET autostart=FALSE WHERE id=$1", [row.id]);
  return e;
}

export async function power(row, action) {
  if (action === "start") return start(row);
  if (action === "stop") return void await stopProc(row);
  if (action === "restart") {
    const e = procs.get(K(row));
    if (e && e.state !== "stopped") { await stopProc(row); await e.exited; }
    return start(row);
  }
  if (action === "kill") {
    const e = procs.get(K(row));
    if (!e || e.state === "stopped") throw new AppError(409, "O servidor já está parado");
    e.stopping = true; e.proc.kill("SIGKILL");
    await query("UPDATE server_requests SET autostart=FALSE WHERE id=$1", [row.id]);
  }
}

export async function command(row, text) {
  const e = procs.get(K(row));
  if (!e || e.state === "stopped") throw new AppError(409, "O servidor está parado");
  e.proc.stdin.write(`${text.replace(/[\r\n]+/g, " ")}\n`);
}

export async function status(row) {
  const e = procs.get(K(row));
  let mem = 0;
  if (e?.proc?.pid && e.state !== "stopped") {
    try { mem = Math.round(Number(/VmRSS:\s+(\d+) kB/.exec(await readFile(`/proc/${e.proc.pid}/status`, "utf8"))?.[1] || 0) / 1024); } catch { /* sem /proc */ }
  }
  return { state: e?.state || "stopped", memory_mb: mem, cpu: null };
}

export const logs = (row, n = 15) => (procs.get(K(row))?.log || []).slice(-n);

export async function removeLocal(row) {
  const e = procs.get(K(row));
  if (e && e.state !== "stopped") { e.stopping = true; e.proc.kill("SIGKILL"); await e.exited; }
  procs.delete(K(row));
  const d = dirOf(row.id);
  if (d.startsWith(path.join(DATA(), "servers") + path.sep)) await rm(d, { recursive: true, force: true });
}

// Ao desligar o painel: pede "stop" a todos, mantendo autostart para voltarem no próximo boot.
export async function stopAll() {
  const es = [...procs.values()].filter(e => e.state !== "stopped");
  for (const e of es) { e.stopping = true; e.state = "stopping"; try { e.proc.stdin.write("stop\n"); } catch { /* já fechou */ } }
  await Promise.race([Promise.all(es.map(e => e.exited)), sleep(20000)]);
  for (const e of es) if (e.state !== "stopped") e.proc.kill("SIGKILL");
}

export async function bootLocal() {
  if (!localEnabled()) return;
  await query("UPDATE server_requests SET status='failed',error='Interrompido por reinício do painel',port=NULL WHERE driver='local' AND status='provisioning'");
  const rows = (await query("SELECT * FROM server_requests WHERE driver='local' AND status='active' AND autostart")).rows;
  for (const row of rows) {
    try { await start(row); console.log(`Servidor local #${row.id} (${row.name}) iniciado.`); }
    catch (e) { console.error(`Falha ao iniciar #${row.id}:`, e.message); }
    await sleep(3000);
  }
}
