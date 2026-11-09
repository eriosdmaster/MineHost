import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import crypto from "node:crypto";
import { query } from "./db.js";
import { hashPassword, verifyPassword, signToken, requireAuth, requireAdmin } from "./auth.js";
import { availableCatalog, defaultSoftware, DEFAULTS, pteroEnabled, controlEnabled, createServer, deleteServer, provisionRequest, linkServer, powerServer, serverStatus, serverLogs } from "./provision.js";

const router = express.Router();
const autoCreate = () => pteroEnabled() || process.env.LOCAL_SERVERS === "true";
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const cookieOpts = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" };
const idParam = z.coerce.number().int().positive();
const STATUSES = ["pending", "approved", "provisioning", "active", "failed", "rejected", "suspended"];
const SERVER_COLS = "id,(external_server_id IS NOT NULL OR driver='local') AS linked,name,edition,software,version,ram_mb,disk_mb,status,connect_address,error,source,created_at";

router.post("/auth/register", authLimit, h(async (req, res) => {
  const p = z.object({ email: z.string().email().max(190), password: z.string().min(10).max(100) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "Informe e-mail válido e senha de 10 a 100 caracteres" });
  try {
    const r = await query("INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id,email,role",
      [p.data.email.toLowerCase(), await hashPassword(p.data.password)]);
    res.cookie("minehost_token", signToken(r.rows[0]), { ...cookieOpts, maxAge: 7 * 864e5 });
    res.status(201).json({ user: r.rows[0] });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Este e-mail já está cadastrado" });
    throw e;
  }
}));

router.post("/auth/login", authLimit, h(async (req, res) => {
  const p = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "Dados inválidos" });
  const r = await query("SELECT * FROM users WHERE lower(email)=lower($1)", [p.data.email]);
  if (!r.rowCount || !(await verifyPassword(p.data.password, r.rows[0].password_hash))) {
    return res.status(401).json({ error: "E-mail ou senha incorretos" });
  }
  const u = r.rows[0];
  res.cookie("minehost_token", signToken(u), { ...cookieOpts, maxAge: 7 * 864e5 });
  res.json({ user: { id: u.id, email: u.email, role: u.role, matrix_user: u.matrix_user } });
}));

router.post("/auth/logout", (_req, res) => { res.clearCookie("minehost_token", cookieOpts); res.json({ ok: true }); });
router.get("/me", requireAuth, (req, res) => res.json({ user: req.user }));

router.get("/catalog", requireAuth, (_req, res) => res.json({ catalog: availableCatalog(), defaults: { java: { ...DEFAULTS.java, software: defaultSoftware("java") }, bedrock: { ...DEFAULTS.bedrock, software: defaultSoftware("bedrock") } }, auto: autoCreate(), control: controlEnabled() }));

router.get("/servers", requireAuth, h(async (req, res) => {
  const r = await query(`SELECT ${SERVER_COLS} FROM server_requests WHERE user_id=$1 ORDER BY id DESC`, [req.user.id]);
  res.json({ servers: r.rows });
}));

router.post("/servers", requireAuth, h(async (req, res) => {
  const { server, auto } = await createServer(req.user, req.body, { source: "web" });
  res.status(201).json({
    server,
    message: auto ? "Criando seu servidor… o status atualiza sozinho." : "Solicitação registrada. O administrador vai criar e vincular seu servidor."
  });
}));

router.post("/servers/:id/power", requireAuth, h(async (req, res) => {
  const id = idParam.safeParse(req.params.id), p = z.object({ action: z.enum(["start", "stop", "restart", "kill"]) }).safeParse(req.body);
  if (!id.success || !p.success) return res.status(400).json({ error: "Dados inválidos" });
  await powerServer(req.user, id.data, p.data.action);
  res.json({ ok: true });
}));

router.get("/servers/:id/status", requireAuth, h(async (req, res) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "ID inválido" });
  const { state, memory_mb, cpu } = await serverStatus(req.user, id.data);
  res.json({ state, memory_mb, cpu });
}));

router.get("/servers/:id/logs", requireAuth, h(async (req, res) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "ID inválido" });
  res.json({ lines: await serverLogs(req.user, id.data, 50) });
}));

router.delete("/servers/:id", requireAuth, h(async (req, res) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "ID inválido" });
  await deleteServer(req.user, id.data);
  res.json({ ok: true });
}));

router.post("/matrix/link-code", requireAuth, h(async (req, res) => {
  const code = crypto.randomBytes(4).toString("hex").toUpperCase();
  await query("UPDATE users SET matrix_link_code=$1,matrix_link_expires=NOW()+INTERVAL '15 minutes' WHERE id=$2", [code, req.user.id]);
  res.json({ code, expires_in_min: 15, instruction: `Envie ao bot: !link ${code}` });
}));

router.delete("/matrix/link", requireAuth, h(async (req, res) => {
  await query("UPDATE users SET matrix_user=NULL,matrix_link_code=NULL,matrix_link_expires=NULL WHERE id=$1", [req.user.id]);
  res.json({ ok: true });
}));

router.get("/admin/overview", requireAuth, requireAdmin, h(async (_req, res) => {
  const q = async sql => (await query(sql)).rows[0].n;
  const [users, servers, pending, providers, nodes] = await Promise.all([
    q("SELECT COUNT(*)::int n FROM users"), q("SELECT COUNT(*)::int n FROM server_requests"),
    q("SELECT COUNT(*)::int n FROM server_requests WHERE status='pending'"),
    q("SELECT COUNT(*)::int n FROM providers"), q("SELECT COUNT(*)::int n FROM nodes")
  ]);
  res.json({ users, servers, pending, providers, nodes, auto: autoCreate() });
}));

router.get("/admin/requests", requireAuth, requireAdmin, h(async (_req, res) => {
  const r = await query("SELECT s.*,u.email FROM server_requests s JOIN users u ON u.id=s.user_id ORDER BY s.created_at DESC LIMIT 200");
  res.json({ requests: r.rows });
}));

router.patch("/admin/requests/:id", requireAuth, requireAdmin, h(async (req, res) => {
  const id = idParam.safeParse(req.params.id);
  const p = z.object({ status: z.enum(STATUSES) }).safeParse(req.body);
  if (!id.success || !p.success) return res.status(400).json({ error: "Dados inválidos" });
  const r = await query("UPDATE server_requests SET status=$1 WHERE id=$2 RETURNING id,status", [p.data.status, id.data]);
  if (!r.rowCount) return res.status(404).json({ error: "Solicitação não encontrada" });
  await query("INSERT INTO audit_logs(actor_id,action,details) VALUES($1,'server.request.updated',$2)", [req.user.id, JSON.stringify({ request_id: id.data, status: p.data.status })]);
  // Aprovar (ou reaprovar uma que falhou) dispara o provisionamento automático, se houver provedor.
  if (p.data.status === "approved" && pteroEnabled()) provisionRequest(id.data);
  res.json({ request: r.rows[0] });
}));

router.post("/admin/requests/:id/link", requireAuth, requireAdmin, h(async (req, res) => {
  const id = idParam.safeParse(req.params.id), p = z.object({ identifier: z.string().trim().min(8).max(36) }).safeParse(req.body);
  if (!id.success || !p.success) return res.status(400).json({ error: "Informe o identificador do servidor" });
  res.json({ server: await linkServer(id.data, p.data.identifier) });
}));

router.delete("/admin/requests/:id", requireAuth, requireAdmin, h(async (req, res) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "ID inválido" });
  await deleteServer(req.user, id.data);
  res.json({ ok: true });
}));

router.get("/admin/providers", requireAuth, requireAdmin, h(async (_req, res) => {
  res.json({ providers: (await query("SELECT * FROM providers ORDER BY id DESC")).rows });
}));

router.post("/admin/providers", requireAuth, requireAdmin, h(async (req, res) => {
  const p = z.object({
    name: z.string().min(2).max(100), kind: z.enum(["official_api", "managed_node"]),
    base_url: z.string().url().optional().or(z.literal("")), enabled: z.boolean().default(false), notes: z.string().max(1000).optional()
  }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "Dados de provedor inválidos" });
  const d = p.data;
  const r = await query("INSERT INTO providers(name,kind,base_url,enabled,notes) VALUES($1,$2,$3,$4,$5) RETURNING *", [d.name, d.kind, d.base_url || null, d.enabled, d.notes || null]);
  res.status(201).json({ provider: r.rows[0] });
}));

router.get("/admin/nodes", requireAuth, requireAdmin, h(async (_req, res) => {
  res.json({ nodes: (await query("SELECT n.*,p.name provider_name FROM nodes n LEFT JOIN providers p ON p.id=n.provider_id ORDER BY n.id DESC")).rows });
}));

router.post("/admin/nodes", requireAuth, requireAdmin, h(async (req, res) => {
  const p = z.object({
    name: z.string().min(2).max(100), provider_id: z.number().int().positive().nullable().optional(), location: z.string().max(120).optional(),
    capacity_ram_mb: z.number().int().min(0).max(1048576), capacity_disk_mb: z.number().int().min(0).max(10485760), enabled: z.boolean().default(false)
  }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "Dados de máquina inválidos" });
  const d = p.data;
  const r = await query("INSERT INTO nodes(name,provider_id,location,capacity_ram_mb,capacity_disk_mb,enabled) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
    [d.name, d.provider_id || null, d.location || null, d.capacity_ram_mb, d.capacity_disk_mb, d.enabled]);
  res.status(201).json({ node: r.rows[0] });
}));

export default router;
