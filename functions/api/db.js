// ── Supabase DB Proxy — Cloudflare Pages Function ──
// Ported from netlify/functions/db.js — logic unchanged, including the
// parent/candidate role block.
import { requireAuth } from "../_utils/auth.js";
import { corsHeaders, jsonResponse } from "../_utils/cors.js";

// admins_list is deliberately NOT in this list — admin accounts are only ever
// read/written through the authenticated login.js / admin.js endpoints.
const ALLOWED_TABLES = [
  "students","staff","attendance","results","fees","expenditure",
  "lessons","assignments","submissions","messages","diary","gallery",
  "elibrary","conduct","settings","timetable","promotions","clinic",
  "counselling","exams","exam_marks","admissions","school_assets","class_remarks",
  "hostel_inventory","hostel_consumption","hostel_requests","hostel_rooms","hostel_rollcall","hostel_incidents"
];

function isPublicRead(table, method) {
  return method === "SELECT" && (table === "settings" || table === "gallery" || table === "school_assets");
}

export async function onRequestOptions({ env }) {
  return new Response("", { status: 200, headers: corsHeaders(env, "Content-Type, Authorization") });
}

export async function onRequestPost({ request, env }) {
  const headers = corsHeaders(env, "Content-Type, Authorization");
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return jsonResponse({ error: "Missing SUPABASE_URL or SUPABASE_KEY env vars" }, 500, headers);
  }

  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResponse({ error: "Invalid JSON" }, 400, headers); }

  const { table, method, id, data, limit } = body;

  if (!table || !ALLOWED_TABLES.includes(table)) {
    return jsonResponse({ error: "Invalid table: " + table }, 400, headers);
  }

  if (!isPublicRead(table, method)) {
    const auth = requireAuth(env, request, {});
    if (!auth.ok) {
      return jsonResponse({ error: auth.error }, auth.status, headers);
    }
    // Parent and candidate tokens are scoped to exactly one student/application
    // (see parent-data.js / candidate-portal.js) — they must never reach this
    // generic proxy, which returns/writes whole tables with no per-row scoping.
    if (auth.payload.role === "parent" || auth.payload.role === "candidate") {
      return jsonResponse({ error: "Forbidden" }, 403, headers);
    }
  }

  const sbHeaders = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_KEY,
    "Authorization": "Bearer " + SUPABASE_KEY
  };

  try {
    let sbRes, result, respText;

    // ── SELECT ──────────────────────────────────────────
    if (method === "SELECT") {
      const maxRows = Math.min(parseInt(limit) || 5000, 10000);
      sbRes = await fetch(
        `${SUPABASE_URL}/rest/v1/${table}?select=id,data&limit=${maxRows}&order=updated_at.desc`,
        { headers: sbHeaders }
      );
      result = await sbRes.json();
      if (!sbRes.ok) {
        console.error("[DB SELECT error]", table, sbRes.status, JSON.stringify(result));
        return jsonResponse([], 200, headers);
      }
      if (!Array.isArray(result)) {
        console.error("[DB SELECT unexpected]", table, JSON.stringify(result));
        return jsonResponse([], 200, headers);
      }
      let rows = result.map(r => r.data).filter(Boolean);
      if (table === "settings") {
        rows = rows.map(row => {
          if (row && row.admins) {
            const clean = { ...row };
            delete clean.admins;
            return clean;
          }
          return row;
        });
      }
      console.log("[DB SELECT]", table, rows.length, "rows");
      return jsonResponse(rows, 200, headers);
    }

    // ── UPSERT ──────────────────────────────────────────
    if (method === "UPSERT") {
      if (!id || data === undefined) {
        return jsonResponse({ error: "id and data required" }, 400, headers);
      }

      let cleanData = data;
      if (table === "settings" && typeof data === "object") {
        cleanData = { ...data };
        ["schoolLogo","schoolStamp","signature"].forEach(field => {
          if (cleanData[field] && String(cleanData[field]).length > 500) {
            cleanData[field] = "";
          }
        });
      }

      const payload = {
        id: String(id),
        data: cleanData,
        updated_at: new Date().toISOString()
      };

      sbRes = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: "POST",
        headers: { ...sbHeaders, "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(payload)
      });

      respText = await sbRes.text();
      if (!sbRes.ok) {
        console.error("[DB UPSERT FAILED]", table, id, sbRes.status, respText);
        return jsonResponse({ ok: false, status: sbRes.status, error: respText }, 200, headers);
      }

      console.log("[DB UPSERT OK]", table, id);
      return jsonResponse({ ok: true }, 200, headers);
    }

    // ── UPSERT_MANY ─────────────────────────────────────
    if (method === "UPSERT_MANY") {
      if (!Array.isArray(data)) return jsonResponse({ error: "data must be array" }, 400, headers);

      const rows = data.map((item, i) => ({
        id: String(item.id || i),
        data: item,
        updated_at: new Date().toISOString()
      }));

      sbRes = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: "POST",
        headers: { ...sbHeaders, "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(rows)
      });

      respText = await sbRes.text();
      if (!sbRes.ok) {
        console.error("[DB UPSERT_MANY FAILED]", table, sbRes.status, respText);
        return jsonResponse({ ok: false, error: respText }, 200, headers);
      }

      console.log("[DB UPSERT_MANY OK]", table, rows.length, "rows");
      return jsonResponse({ ok: true }, 200, headers);
    }

    // ── DELETE ──────────────────────────────────────────
    if (method === "DELETE") {
      if (!id) return jsonResponse({ error: "id required" }, 400, headers);
      sbRes = await fetch(
        `${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(String(id))}`,
        { method: "DELETE", headers: sbHeaders }
      );
      respText = await sbRes.text();
      if (!sbRes.ok) console.error("[DB DELETE FAILED]", table, id, sbRes.status, respText);
      return jsonResponse({ ok: sbRes.ok }, 200, headers);
    }

    return jsonResponse({ error: "Unknown method: " + method }, 400, headers);

  } catch (err) {
    console.error("[DB Proxy exception]", err.message, err.stack);
    return jsonResponse({ error: err.message }, 500, headers);
  }
}
