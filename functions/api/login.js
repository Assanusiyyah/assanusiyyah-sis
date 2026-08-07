// Dedicated login endpoint — checks admins_list table directly, issues a signed session token.
// Ported from netlify/functions/login.js — logic unchanged, only the
// request/response plumbing is Cloudflare Pages Functions-shaped.
import { signToken, verifyPassword, isHashed, hashPassword } from "../_utils/auth.js";
import { checkLockout, recordFailure, recordSuccess } from "../_utils/rateLimit.js";
import { corsHeaders, jsonResponse } from "../_utils/cors.js";

// A stable dummy hash so a no-such-username lookup pays the same scrypt cost
// as a real one below — otherwise response timing leaks which usernames exist.
const DUMMY_HASH = "scrypt$" + "00".repeat(16) + "$" + "00".repeat(64);

export async function onRequestOptions({ env }) {
  return new Response("", { status: 200, headers: corsHeaders(env) });
}

export async function onRequestPost({ request, env }) {
  const headers = corsHeaders(env);
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_KEY;

  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResponse({ error: "Invalid JSON" }, 400, headers); }

  const { username, password } = body;
  if (!username || !password) {
    return jsonResponse({ error: "Username and password required" }, 400, headers);
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return jsonResponse({ success: false, error: "Database not configured." }, 500, headers);
  }

  const lockKey = "admin:" + String(username).trim().toLowerCase();
  const lockout = await checkLockout(env, lockKey);
  if (lockout.blocked) {
    return jsonResponse({ success: false, error: "Too many failed attempts. Try again in " + Math.ceil(lockout.retryAfterSec / 60) + " minute(s)." }, 429, headers);
  }

  const sbHeaders = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_KEY,
    "Authorization": "Bearer " + SUPABASE_KEY
  };

  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/admins_list?select=id,data&limit=500`,
      { headers: sbHeaders }
    );

    if (!resp.ok) {
      const err = await resp.text();
      console.error("[Login] Supabase fetch failed:", resp.status, err);
      return jsonResponse({ success: false, error: "DB error: " + resp.status }, 200, headers);
    }

    const rows = await resp.json();

    const found = rows.find(function(row) { return row.data && row.data.username === username; });
    const match = (found && (isHashed(found.data.password) ? verifyPassword(password, found.data.password) : found.data.password === password))
      ? found : null;

    if (!match) {
      if (!found || !isHashed(found.data.password)) verifyPassword(password, DUMMY_HASH); // pay the same scrypt cost either way
      await recordFailure(env, lockKey);
      console.log("[Login] FAILED for:", username);
      return jsonResponse({ success: false, error: "Invalid credentials" }, 200, headers);
    }

    const admin = match.data;
    if (admin.active === false) {
      return jsonResponse({ success: false, error: "Account deactivated" }, 200, headers);
    }
    await recordSuccess(env, lockKey);

    if (!isHashed(admin.password)) {
      const rehashed = Object.assign({}, admin, { password: hashPassword(password) });
      fetch(`${SUPABASE_URL}/rest/v1/admins_list`, {
        method: "POST",
        headers: Object.assign({}, sbHeaders, { "Prefer": "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify({ id: String(admin.id), data: rehashed, updated_at: new Date().toISOString() })
      }).catch(function(e){ console.error("[Login] password rehash failed:", e.message); });
    }

    const token = signToken(env, {
      sub: admin.id,
      username: admin.username,
      role: admin.role,
      permissions: admin.permissions || []
    }, 12 * 3600);

    const safeAdmin = Object.assign({}, admin);
    delete safeAdmin.password;

    console.log("[Login] SUCCESS for:", username);
    return jsonResponse({ success: true, token: token, admin: safeAdmin }, 200, headers);

  } catch (err) {
    console.error("[Login] Exception:", err.message);
    return jsonResponse({ error: err.message }, 500, headers);
  }
}
