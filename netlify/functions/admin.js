// ── Admin account management — Netlify Function ──
// Authenticated CRUD for the admins_list table. This is the ONLY place
// admins_list is written or read with full detail — the generic /api/db
// proxy no longer allows that table at all (see db.js).
const { requireAuth, hashPassword } = require("./utils/auth");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function corsHeaders() {
  const isProd = process.env.CONTEXT === "production";
  const origin = (isProd && process.env.ALLOWED_ORIGIN) ? process.env.ALLOWED_ORIGIN : "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
}

function stripPassword(admin) {
  const a = Object.assign({}, admin);
  delete a.password;
  delete a.newPassword;
  return a;
}

exports.handler = async function(event, context) {
  const headers = corsHeaders();

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  const auth = requireAuth(event, { roles: ["root", "Admin"] });
  if (!auth.ok) return { statusCode: auth.statusCode, headers, body: JSON.stringify({ error: auth.error }) };

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Database not configured." }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const sbHeaders = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_KEY,
    "Authorization": "Bearer " + SUPABASE_KEY
  };

  try {
    if (body.action === "list") {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/admins_list?select=id,data&limit=500`, { headers: sbHeaders });
      if (!resp.ok) return { statusCode: 500, headers, body: JSON.stringify({ error: "DB error: " + resp.status }) };
      const rows = await resp.json();
      const admins = (Array.isArray(rows) ? rows : []).map(function(r) { return stripPassword(r.data || {}); });
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, admins: admins }) };
    }

    if (body.action === "upsert") {
      const admin = body.admin;
      const isNew = !(admin && admin.id);

      // Full name/username are only required when creating a brand-new account —
      // a partial update (e.g. just toggling `active`) merges over the existing row.
      if (!admin || (isNew && (!admin.name || !admin.username))) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "name and username are required" }) };
      }
      if (isNew && !(admin.password || admin.newPassword)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Password is required for new accounts." }) };
      }

      const id = admin.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).toUpperCase();

      let existingData = null;
      if (!isNew) {
        const existingResp = await fetch(`${SUPABASE_URL}/rest/v1/admins_list?id=eq.${encodeURIComponent(id)}&select=data`, { headers: sbHeaders });
        const existingRows = await existingResp.json();
        if (Array.isArray(existingRows) && existingRows[0]) existingData = existingRows[0].data;
        if (!existingData) return { statusCode: 404, headers, body: JSON.stringify({ error: "Account not found" }) };
      }

      const finalAdmin = Object.assign({}, existingData || {}, admin, { id: id });
      const newPlainPassword = admin.newPassword || admin.password;
      if (newPlainPassword) {
        finalAdmin.password = hashPassword(newPlainPassword);
      } else if (existingData) {
        finalAdmin.password = existingData.password; // keep existing hash
      }
      delete finalAdmin.newPassword;

      const upsertResp = await fetch(`${SUPABASE_URL}/rest/v1/admins_list`, {
        method: "POST",
        headers: Object.assign({}, sbHeaders, { "Prefer": "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify({ id: String(id), data: finalAdmin, updated_at: new Date().toISOString() })
      });

      if (!upsertResp.ok) {
        const t = await upsertResp.text();
        console.error("[Admin] upsert failed:", upsertResp.status, t);
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Save failed" }) };
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, admin: stripPassword(finalAdmin) }) };
    }

    if (body.action === "deactivate") {
      if (!body.id) return { statusCode: 400, headers, body: JSON.stringify({ error: "id required" }) };
      const existingResp = await fetch(`${SUPABASE_URL}/rest/v1/admins_list?id=eq.${encodeURIComponent(body.id)}&select=data`, { headers: sbHeaders });
      const existingRows = await existingResp.json();
      if (!Array.isArray(existingRows) || !existingRows[0]) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: "Not found" }) };
      }
      const admin = Object.assign({}, existingRows[0].data, { active: false });
      const deactivateResp = await fetch(`${SUPABASE_URL}/rest/v1/admins_list`, {
        method: "POST",
        headers: Object.assign({}, sbHeaders, { "Prefer": "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify({ id: String(body.id), data: admin, updated_at: new Date().toISOString() })
      });
      if (!deactivateResp.ok) return { statusCode: 500, headers, body: JSON.stringify({ error: "Save failed" }) };
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    if (body.action === "delete") {
      if (!body.id) return { statusCode: 400, headers, body: JSON.stringify({ error: "id required" }) };
      if (body.id === "ADM001") return { statusCode: 400, headers, body: JSON.stringify({ error: "Cannot delete the root account" }) };
      const deleteResp = await fetch(
        `${SUPABASE_URL}/rest/v1/admins_list?id=eq.${encodeURIComponent(String(body.id))}`,
        { method: "DELETE", headers: sbHeaders }
      );
      if (!deleteResp.ok) return { statusCode: 500, headers, body: JSON.stringify({ error: "Delete failed" }) };
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action: " + body.action }) };

  } catch(err) {
    console.error("[Admin]", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
