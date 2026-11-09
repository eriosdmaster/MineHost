import "dotenv/config";
import { initDb, pool } from "../db.js";
await initDb();
console.log("Banco inicializado.");
await pool.end();
