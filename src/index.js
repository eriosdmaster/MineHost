import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import routes from "./routes.js";
import { initDb, pool } from "./db.js";
import { startMatrixBot } from "./matrix.js";
import { bootLocal, stopAll } from "./local.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: { useDefaults: true, directives: { upgradeInsecureRequests: null } } }));
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
app.use("/api", routes);
app.use(express.static(path.join(__dirname, "../public")));
app.use("/api", (_req, res) => res.status(404).json({ error: "Rota não encontrada" }));
app.get("/health", (_req, res) => res.json({ ok: true, service: "minehost-panel" }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "../public/index.html")));

app.use((err, _req, res, _next) => {
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : "Erro interno" });
});

const port = Number(process.env.PORT || process.env.SERVER_PORT || 3000);
await initDb();
const server = app.listen(port, "0.0.0.0", () => console.log(`MineHost Panel ouvindo na porta ${port}`));
bootLocal().catch(e => console.error("Boot local:", e));
startMatrixBot().catch(e => console.error("Matrix bot encerrou:", e));

const shutdown = async () => {
  server.close();
  await stopAll();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
