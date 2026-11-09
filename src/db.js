import pg from "pg";
import bcrypt from "bcryptjs";

const { Pool } = pg;
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL não configurada");

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000
});

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
      matrix_user TEXT UNIQUE,
      matrix_link_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS providers (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      base_url TEXT,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS nodes (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      provider_id BIGINT REFERENCES providers(id) ON DELETE SET NULL,
      location TEXT,
      capacity_ram_mb INTEGER NOT NULL DEFAULT 0,
      capacity_disk_mb INTEGER NOT NULL DEFAULT 0,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS server_requests (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      edition TEXT NOT NULL CHECK (edition IN ('java','bedrock')),
      software TEXT NOT NULL,
      ram_mb INTEGER NOT NULL,
      disk_mb INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      provider_id BIGINT REFERENCES providers(id) ON DELETE SET NULL,
      external_server_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY,
      actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_server_requests_user ON server_requests(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS matrix_link_expires TIMESTAMPTZ;
    ALTER TABLE server_requests ADD COLUMN IF NOT EXISTS version TEXT;
    ALTER TABLE server_requests ADD COLUMN IF NOT EXISTS connect_address TEXT;
    ALTER TABLE server_requests ADD COLUMN IF NOT EXISTS error TEXT;
    ALTER TABLE server_requests ADD COLUMN IF NOT EXISTS driver TEXT;
    ALTER TABLE server_requests ADD COLUMN IF NOT EXISTS port INTEGER;
    ALTER TABLE server_requests ADD COLUMN IF NOT EXISTS autostart BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE server_requests ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'web';
  `);

  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (email && password) {
    const existing = await query("SELECT id FROM users WHERE lower(email)=lower($1)", [email]);
    if (!existing.rowCount) {
      const hash = await bcrypt.hash(password, 12);
      await query("INSERT INTO users(email,password_hash,role) VALUES($1,$2,'admin')", [email.toLowerCase(), hash]);
      console.log(`Administrador inicial criado: ${email}`);
    }
  }
}
