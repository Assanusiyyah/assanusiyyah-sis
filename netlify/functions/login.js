// Dedicated login endpoint — checks admins_list table directly, issues a signed session token.
const { signToken, verifyPassword, isHashed, hashPassword } = require("./utils/auth");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function corsHeaders() {
  const isProd = process.env.CONTEXT === "production";
  const origin = (isProd && process.env.ALLOWED_ORIGIN) ? process.env.ALLOWED_ORIGIN : "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
}

exports.handler = async function(event, context) {
  const headers = corsHeaders();

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { username, password } = body;
  if (!username || !password) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Username and password required" }) };
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: "Database not configured." }) };
  }

  const sbHeaders = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_KEY,
    "Authorization": "Bearer " + SUPABASE_KEY
  };

  try {
    // Fetch all admins from Supabase
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/admins_list?select=id,data&limit=500`,
      { headers: sbHeaders }
    );

    if (!resp.ok) {
      const err = await resp.text();
      console.error("[Login] Supabase fetch failed:", resp.status, err);
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: "DB error: " + resp.status }) };
    }

    const rows = await resp.json();

    // Find matching admin — supports both hashed ("scrypt$...") and legacy plaintext passwords.
    const match = rows.find(function(row) {
      const a = row.data;
      if (!a || a.username !== username) return false;
      return isHashed(a.password) ? verifyPassword(password, a.password) : a.password === password;
    });

    if (!match) {
      console.log("[Login] FAILED for:", username);
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: "Invalid credentials" }) };
    }

    const admin = match.data;
    if (admin.active === false) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: "Account deactivated" }) };
    }

    // Lazy migration: a matching plaintext password means credentials were correct —
    // rehash and store now so this row never needs a plaintext compare again.
    if (!isHashed(admin.password)) {
      const rehashed = Object.assign({}, admin, { password: hashPassword(password) });
      fetch(`${SUPABASE_URL}/rest/v1/admins_list`, {
        method: "POST",
        headers: Object.assign({}, sbHeaders, { "Prefer": "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify({ id: String(admin.id), data: rehashed, updated_at: new Date().toISOString() })
      }).catch(function(e){ console.error("[Login] password rehash failed:", e.message); });
    }

    const token = signToken({
      sub: admin.id,
      username: admin.username,
      role: admin.role,
      permissions: admin.permissions || []
    }, 12 * 3600);

    const safeAdmin = Object.assign({}, admin);
    delete safeAdmin.password;

    console.log("[Login] SUCCESS for:", username);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, token: token, admin: safeAdmin }) };

  } catch(err) {
    console.error("[Login] Exception:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
