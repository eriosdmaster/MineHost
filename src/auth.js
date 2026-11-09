import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { query } from "./db.js";

const secret = () => {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET deve ter pelo menos 32 caracteres");
  }
  return process.env.JWT_SECRET;
};

export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function signToken(user) {
  return jwt.sign({ sub: String(user.id), role: user.role }, secret(), { expiresIn: "7d" });
}

export async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.minehost_token ||
      (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null);
    if (!token) return res.status(401).json({ error: "Autenticação necessária" });
    const payload = jwt.verify(token, secret());
    const result = await query("SELECT id,email,role,matrix_user,created_at FROM users WHERE id=$1", [payload.sub]);
    if (!result.rowCount) return res.status(401).json({ error: "Sessão inválida" });
    req.user = result.rows[0];
    next();
  } catch {
    return res.status(401).json({ error: "Sessão inválida ou expirada" });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Acesso administrativo necessário" });
  next();
}
