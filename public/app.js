const $ = s => document.querySelector(s);
const STATUS = { pending: "Pendente", approved: "Aprovado", provisioning: "Criando…", active: "Ativo", failed: "Falhou", rejected: "Recusado", suspended: "Suspenso" };
let mode = "login", me = null, catalog = {}, defaults = {}, timer = null, control = false;

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
async function api(url, o = {}) {
  const r = await fetch("/api" + url, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...o });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Erro HTTP ${r.status}`);
  return d;
}
function toast(msg, type = "ok") {
  const t = document.createElement("div"); t.className = `toast ${type}`; t.textContent = msg;
  $("#toasts").append(t); setTimeout(() => t.remove(), 4500);
}
const run = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, "err"); } };

function showAuth() { $("#auth").hidden = false; $("#app").hidden = true; }
async function showApp() {
  $("#auth").hidden = true; $("#app").hidden = false;
  $("#hello").textContent = `Olá, ${me.email}`;
  $("#admin").hidden = me.role !== "admin";
  const c = await api("/catalog"); catalog = c.catalog; defaults = c.defaults; control = c.control;
  $("#autoPill").textContent = c.auto ? "Criação automática" : "Criado pelo admin";
  $("#serverSubmit").textContent = c.auto ? "Criar servidor" : "Enviar solicitação";
  fillSoftware(); renderMatrix(); loadServers();
  if (me.role === "admin") { loadOverview(); loadAdminRequests(); }
}

// ----- auth -----
function setMode(m) {
  mode = m;
  $("#loginTab").classList.toggle("active", m === "login"); $("#registerTab").classList.toggle("active", m === "register");
  $("#authSubmit").textContent = m === "login" ? "Entrar" : "Criar conta";
}
$("#loginTab").onclick = () => setMode("login");
$("#registerTab").onclick = () => setMode("register");
$("#authForm").onsubmit = async e => {
  e.preventDefault(); $("#authError").textContent = "";
  try { me = (await api(`/auth/${mode}`, { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(e.target))) })).user; await showApp(); }
  catch (err) { $("#authError").textContent = err.message; }
};
$("#logout").onclick = async () => { await api("/auth/logout", { method: "POST" }); me = null; clearTimeout(timer); showAuth(); };

// ----- criar servidor -----
function fillSoftware() {
  const ed = $("#edition").value;
  $("#software").innerHTML = Object.entries(catalog[ed] || {}).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("");
  const f = $("#serverForm"); f.ram_mb.value = defaults[ed]?.ram_mb ?? 2048; f.disk_mb.value = defaults[ed]?.disk_mb ?? 5120;
}
$("#edition").onchange = fillSoftware;
$("#plans").onclick = e => {
  const b = e.target.closest("button[data-ram]"); if (!b) return;
  $("#serverForm").ram_mb.value = b.dataset.ram; $("#serverForm").disk_mb.value = b.dataset.disk;
};
$("#serverForm").onsubmit = run(async e => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target)); d.ram_mb = +d.ram_mb; d.disk_mb = +d.disk_mb;
  $("#serverSubmit").disabled = true;
  try { const r = await api("/servers", { method: "POST", body: JSON.stringify(d) }); toast(r.message); e.target.name.value = ""; e.target.version.value = ""; await loadServers(); }
  finally { $("#serverSubmit").disabled = false; }
});

// ----- lista -----
const badge = s => `<span class="status ${esc(s.status)}" title="${esc(s.error || "")}">${esc(STATUS[s.status] || s.status)}</span>`;
async function loadServers() {
  clearTimeout(timer);
  const { servers } = await api("/servers");
  $("#serverRows").innerHTML = servers.map(s => `<tr>
    <td>#${s.id} ${esc(s.name)}</td><td>${esc(s.edition)} · ${esc(s.software)}${s.version ? " " + esc(s.version) : ""}</td>
    <td>${s.ram_mb} MB · ${s.disk_mb} MB</td><td>${badge(s)}</td>
    <td>${s.connect_address ? `<button class="chipbtn" data-copy="${esc(s.connect_address)}">${esc(s.connect_address)}</button>` : "—"}</td>
    <td>${control && s.linked && s.status === "active" ? `<button class="ghost sm" data-pw="start:${s.id}">▶</button><button class="ghost sm" data-pw="restart:${s.id}">🔄</button><button class="ghost sm" data-pw="stop:${s.id}">⏹</button>` : ""}<button class="danger" data-del="${s.id}">Excluir</button></td></tr>`).join("") || '<tr><td colspan="6" class="empty">Nenhum servidor ainda. Crie o primeiro acima.</td></tr>';
  if (servers.some(s => s.status === "provisioning")) timer = setTimeout(() => loadServers().catch(() => {}), 5000);
}
$("#refresh").onclick = run(loadServers);
$("#serverRows").onclick = run(async e => {
  const c = e.target.closest("[data-copy]"), d = e.target.closest("[data-del]"), w = e.target.closest("[data-pw]");
  if (w) { const [a, id] = w.dataset.pw.split(":"); await api(`/servers/${id}/power`, { method: "POST", body: JSON.stringify({ action: a }) }); toast("Comando enviado"); }
  if (c) { await navigator.clipboard.writeText(c.dataset.copy); toast("Endereço copiado"); }
  if (d && confirm("Excluir este servidor? Isso não pode ser desfeito.")) { await api(`/servers/${d.dataset.del}`, { method: "DELETE" }); toast("Servidor excluído"); await loadServers(); }
});

// ----- matrix -----
function renderMatrix() {
  $("#matrixState").textContent = me.matrix_user ? `Vinculado a ${me.matrix_user}.` : "Gere um código e envie ao bot (!link CODIGO) para criar servidores pelo Element X.";
  $("#matrixUnlink").hidden = !me.matrix_user; $("#matrixResult").textContent = "";
}
$("#matrixCode").onclick = run(async () => {
  const d = await api("/matrix/link-code", { method: "POST", body: "{}" });
  $("#matrixResult").textContent = d.code; toast(`Código válido por ${d.expires_in_min} min`);
});
$("#matrixUnlink").onclick = run(async () => { await api("/matrix/link", { method: "DELETE" }); me.matrix_user = null; renderMatrix(); toast("Matrix desvinculado"); });

// ----- admin -----
async function loadOverview() {
  const d = await api("/admin/overview"); $("#adminStats").hidden = false;
  $("#adminStats").innerHTML = Object.entries({ Usuários: d.users, Servidores: d.servers, Pendentes: d.pending, Provedores: d.providers, Máquinas: d.nodes }).map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join("");
}
async function loadAdminRequests() {
  const { requests } = await api("/admin/requests");
  $("#adminRows").innerHTML = requests.map(s => `<tr><td>${esc(s.email)}</td><td>#${s.id} ${esc(s.name)}</td><td>${esc(s.edition)}/${esc(s.software)}</td><td>${badge(s)}</td>
    <td><select data-id="${s.id}" class="statusSelect">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}"${k === s.status ? " selected" : ""}>${v}</option>`).join("")}</select></td>
    <td>${s.status !== "active" ? `<button class="secondary sm" data-link="${s.id}">Vincular</button>` : ""}<button class="danger" data-adel="${s.id}">Excluir</button></td></tr>`).join("") || '<tr><td colspan="6" class="empty">Sem solicitações.</td></tr>';
}
$("#adminRows").onchange = run(async e => {
  const el = e.target.closest(".statusSelect"); if (!el) return;
  await api(`/admin/requests/${el.dataset.id}`, { method: "PATCH", body: JSON.stringify({ status: el.value }) });
  toast("Status atualizado"); setTimeout(() => { loadAdminRequests(); loadOverview(); }, 1500);
});
$("#adminRows").onclick = run(async e => {
  const d = e.target.closest("[data-adel]"), l = e.target.closest("[data-link]");
  if (l) { const identifier = prompt("Identificador do servidor criado no painel da hospedagem (8 caracteres da URL):"); if (identifier) { await api(`/admin/requests/${l.dataset.link}/link`, { method: "POST", body: JSON.stringify({ identifier }) }); toast("Servidor vinculado"); await Promise.all([loadAdminRequests(), loadOverview()]); } }
  if (d && confirm("Excluir esta solicitação/servidor?")) { await api(`/admin/requests/${d.dataset.adel}`, { method: "DELETE" }); await Promise.all([loadAdminRequests(), loadOverview()]); }
});
$("#providerForm").onsubmit = run(async e => {
  e.preventDefault(); const d = Object.fromEntries(new FormData(e.target)); d.enabled = false;
  await api("/admin/providers", { method: "POST", body: JSON.stringify(d) }); toast("Provedor registrado"); e.target.reset(); loadOverview();
});
$("#nodeForm").onsubmit = run(async e => {
  e.preventDefault(); const d = Object.fromEntries(new FormData(e.target));
  d.capacity_ram_mb = +d.capacity_ram_mb; d.capacity_disk_mb = +d.capacity_disk_mb; d.enabled = false;
  await api("/admin/nodes", { method: "POST", body: JSON.stringify(d) }); toast("Máquina registrada"); e.target.reset(); loadOverview();
});

(async () => { try { me = (await api("/me")).user; await showApp(); } catch { showAuth(); } })();
