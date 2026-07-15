// ── Shared auth helpers for Netlify Functions ──
// Lives in a subfolder (not netlify/functions/*.js directly) so it is NOT
// auto-registered as its own public function by Netlify's zip-it-and-ship-it.
// Signed tokens: HMAC-SHA256 over a base64url JSON payload, keyed by AUTH_SECRET.
// Password hashing: Node's built-in crypto.scrypt (no extra npm dependency).

const crypto = require("crypto");

function base64url(str) {
  return Buffer.from(str, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64").toString("utf8");
}

function getSecret() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not configured");
  return secret;
}

function signToken(payload, expiresInSec) {
  const body = Object.assign({}, payload, { exp: Math.floor(Date.now() / 1000) + (expiresInSec || 12 * 3600) });
  const encoded = base64url(JSON.stringify(body));
  const sig = crypto.createHmac("sha256", getSecret()).update(encoded).digest("hex");
  return encoded + "." + sig;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot === -1) return null;
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!encoded || !sig) return null;

  let expectedSig;
  try {
    expectedSig = crypto.createHmac("sha256", getSecret()).update(encoded).digest("hex");
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

// Stored format: "scrypt$<saltHex>$<hashHex>" — self-identifying so legacy
// plaintext rows (any string not starting with "scrypt$") stay distinguishable
// during the dual-read migration in login.js.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return "scrypt$" + salt + "$" + hash;
}

function isHashed(stored) {
  return typeof stored === "string" && stored.indexOf("scrypt$") === 0;
}

function verifyPassword(password, stored) {
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

// Reads `Authorization: Bearer <token>` off a Netlify Functions `event`,
// verifies it, and optionally checks the token's role against an allow-list.
function requireAuth(event, opts) {
  opts = opts || {};
  const headers = event.headers || {};
  const authHeader = headers.authorization || headers.Authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(String(authHeader).trim());
  const token = match ? match[1] : null;
  const payload = token ? verifyToken(token) : null;

  if (!payload) {
    return { ok: false, statusCode: 401, error: "Unauthorized" };
  }
  if (opts.roles && opts.roles.length && opts.roles.indexOf(payload.role) === -1) {
    return { ok: false, statusCode: 403, error: "Forbidden" };
  }
  return { ok: true, payload: payload };
}

module.exports = { signToken, verifyToken, hashPassword, verifyPassword, isHashed, requireAuth };
