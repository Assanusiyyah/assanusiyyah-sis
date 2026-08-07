// ── Shared auth helpers for Cloudflare Pages Functions ──
// Ported from netlify/functions/utils/auth.js — same HMAC-signed-token and
// scrypt password-hashing scheme, so existing tokens and stored password
// hashes in Supabase keep working unchanged after the platform switch.
//
// Uses node:crypto via Cloudflare's Node.js compatibility layer (requires
// the "nodejs_compat" flag — see wrangler.toml at the repo root). scrypt
// support under that layer has NOT been verified on this platform yet —
// test a real admin login on the Cloudflare preview before trusting this.
import crypto from "node:crypto";

function base64url(str) {
  return Buffer.from(str, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64").toString("utf8");
}

function getSecret(env) {
  const secret = env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not configured");
  return secret;
}

export function signToken(env, payload, expiresInSec) {
  const body = Object.assign({}, payload, { exp: Math.floor(Date.now() / 1000) + (expiresInSec || 12 * 3600) });
  const encoded = base64url(JSON.stringify(body));
  const sig = crypto.createHmac("sha256", getSecret(env)).update(encoded).digest("hex");
  return encoded + "." + sig;
}

export function verifyToken(env, token) {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot === -1) return null;
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!encoded || !sig) return null;

  let expectedSig;
  try {
    expectedSig = crypto.createHmac("sha256", getSecret(env)).update(encoded).digest("hex");
  } catch (e) {
    return null;
  }
  const sigBuf = Buffer.from(sig, "hex");
  const expectedBuf = Buffer.from(expectedSig, "hex");
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  let payload;
  try {
    payload = JSON.parse(base64urlDecode(encoded));
  } catch (e) {
    return null;
  }
  if (!payload.exp || Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return "scrypt$" + salt + "$" + hash;
}

export function isHashed(stored) {
  return typeof stored === "string" && stored.indexOf("scrypt$") === 0;
}

export function verifyPassword(password, stored) {
  if (!isHashed(stored)) return false;
  const parts = stored.split("$");
  if (parts.length !== 3) return false;
  const salt = parts[1];
  const hash = parts[2];
  let candidate;
  try {
    candidate = crypto.scryptSync(String(password), salt, 64).toString("hex");
  } catch (e) {
    return false;
  }
  const hashBuf = Buffer.from(hash, "hex");
  const candidateBuf = Buffer.from(candidate, "hex");
  if (hashBuf.length !== candidateBuf.length) return false;
  return crypto.timingSafeEqual(hashBuf, candidateBuf);
}

// Reads `Authorization: Bearer <token>` off a Fetch API Request, verifies it,
// and optionally checks the token's role against an allow-list.
export function requireAuth(env, request, opts) {
  opts = opts || {};
  const authHeader = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(String(authHeader).trim());
  const token = match ? match[1] : null;
  const payload = token ? verifyToken(env, token) : null;

  if (!payload) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  if (opts.roles && opts.roles.length && opts.roles.indexOf(payload.role) === -1) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  return { ok: true, payload: payload };
}
