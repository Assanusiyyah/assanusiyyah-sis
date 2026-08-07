// ── Admin account management — Cloudflare Pages Function ──
// Ported from netlify/functions/admin.js — logic unchanged.
import { requireAuth, hashPassword } from "../_utils/auth.js";
import { corsHeaders, jsonResponse } from "../_utils/cors.js";

function stripPassword(admin) {
  const a = Object.assign({}, admin);
  delete a.password;
  delete a.newPassword;
  return a;
}

export async function onRequestOptions({ env }) {
  return new Response("", { status: 200, headers: corsHeaders(env, "Content-Type, Authorization") });
}

export async function onRequestPost({ request, env }) {
  const headers = corsHeaders(env, "Content-Type, Authorization");
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_KEY;

  const auth = requireAuth(env, request, { roles: ["root", "Admin"] });
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status, headers);

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return jsonResponse({ error: "Database not configured." }, 500, headers);
  }

  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResponse({ error: "Invalid JSON" }, 400, headers); }

  const sbHeaders = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_KEY,
    "Authorization": "Bearer " + SUPABASE_KEY
  };

  try {
    if (body.action === "list") {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/admins_list?select=id,data&limit=500`, { headers: sbHeaders });
      if (!resp.ok) return jsonResponse({ error: "DB error: " + resp.status }, 500, headers);
      const rows = await resp.json();
      const admins = (Array.isArray(rows) ? rows : []).map(function(r) { return stripPassword(r.data || {}); });
      return jsonResponse({ success: true, admins: admins }, 200, headers);
    }

    if (body.action === "upsert") {
      const admin = body.admin;
      const isNew = !(admin && admin.id);

      if (!admin || (isNew && (!admin.name || !admin.username))) {
        return jsonResponse({ error: "name and username are required" }, 400, headers);
      }
      if (isNew && !(admin.password || admin.newPassword)) {
        return jsonResponse({ error: "Password is required for new accounts." }, 400, headers);
      }

      const id = admin.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).toUpperCase();

      let existingData = null;
      if (!isNew) {
        const existingResp = await fetch(`${SUPABASE_URL}/rest/v1/admins_list?id=eq.${encodeURIComponent(id)}&select=data`, { headers: sbHeaders });
        const existingRows = await existingResp.json();
        if (Array.isArray(existingRows) && existingRows[0]) existingData = existingRows[0].data;
        if (!existingData) return jsonResponse({ error: "Account not found" }, 404, headers);
      }

      const finalAdmin = Object.assign({}, existingData || {}, admin, { id: id });
      const newPlainPassword = admin.newPassword || admin.password;
      if (newPlainPassword) {
        finalAdmin.password = hashPassword(newPlainPassword);
      } else if (existingData) {
        finalAdmin.password = existingData.password;
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
        return jsonResponse({ error: "Save failed" }, 500, headers);
      }

      return jsonResponse({ success: true, admin: stripPassword(finalAdmin) }, 200, headers);
    }

    if (body.action === "deactivate") {
      if (!body.id) return jsonResponse({ error: "id required" }, 400, headers);
      const existingResp = await fetch(`${SUPABASE_URL}/rest/v1/admins_list?id=eq.${encodeURIComponent(body.id)}&select=data`, { headers: sbHeaders });
      const existingRows = await existingResp.json();
      if (!Array.isArray(existingRows) || !existingRows[0]) {
        return jsonResponse({ error: "Not found" }, 404, headers);
      }
      const admin = Object.assign({}, existingRows[0].data, { active: false });
      const deactivateResp = await fetch(`${SUPABASE_URL}/rest/v1/admins_list`, {
        method: "POST",
        headers: Object.assign({}, sbHeaders, { "Prefer": "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify({ id: String(body.id), data: admin, updated_at: new Date().toISOString() })
      });
      if (!deactivateResp.ok) return jsonResponse({ error: "Save failed" }, 500, headers);
      return jsonResponse({ success: true }, 200, headers);
    }

    if (body.action === "delete") {
      if (!body.id) return jsonResponse({ error: "id required" }, 400, headers);
      if (body.id === "ADM001") return jsonResponse({ error: "Cannot delete the root account" }, 400, headers);
      const deleteResp = await fetch(
        `${SUPABASE_URL}/rest/v1/admins_list?id=eq.${encodeURIComponent(String(body.id))}`,
        { method: "DELETE", headers: sbHeaders }
      );
      if (!deleteResp.ok) return jsonResponse({ error: "Delete failed" }, 500, headers);
      return jsonResponse({ success: true }, 200, headers);
    }

    return jsonResponse({ error: "Unknown action: " + body.action }, 400, headers);

  } catch (err) {
    console.error("[Admin]", err.message);
    return jsonResponse({ error: err.message }, 500, headers);
  }
}
