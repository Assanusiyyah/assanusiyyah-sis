// ── Supabase DB Proxy — Netlify Function ──
const { requireAuth } = require("./utils/auth");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// admins_list is deliberately NOT in this list — admin accounts are only ever
// read/written through the authenticated login.js / admin.js endpoints.
const ALLOWED_TABLES = [
  "students","staff","attendance","results","fees","expenditure",
  "lessons","assignments","submissions","messages","diary","gallery",
  "elibrary","conduct","settings","timetable","promotions","clinic",
  "counselling","exams","exam_marks","admissions","school_assets","class_remarks"
];

// The login screen needs to read these, unauthenticated, before anyone has
// logged in: settings (branding text), gallery (slideshow), school_assets
// (logo/stamp/signature images — settings.schoolLogo itself gets stripped
// server-side on UPSERT when large, so the real image lives here). None of
// these tables carry credentials. Everything else requires a token.
function isPublicRead(table, method) {
  return method === "SELECT" && (table === "settings" || table === "gallery" || table === "school_assets");
}

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

exports.handler = async function(event, context) {
  const headers = corsHeaders();

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing SUPABASE_URL or SUPABASE_KEY env vars" }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { table, method, id, data, limit } = body;

  if (!table || !ALLOWED_TABLES.includes(table)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid table: " + table }) };
  }

  if (!isPublicRead(table, method)) {
    const auth = requireAuth(event, {});
    if (!auth.ok) {
      return { statusCode: auth.statusCode, headers, body: JSON.stringify({ error: auth.error }) };
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
        return { statusCode: 200, headers, body: JSON.stringify([]) };
      }
      if (!Array.isArray(result)) {
        console.error("[DB SELECT unexpected]", table, JSON.stringify(result));
        return { statusCode: 200, headers, body: JSON.stringify([]) };
      }
      let rows = result.map(r => r.data).filter(Boolean);
      // Backstop: never let admin credentials leave via the settings row,
      // even though they're also being removed at the source.
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
      return { statusCode: 200, headers, body: JSON.stringify(rows) };
    }

    // ── UPSERT ──────────────────────────────────────────
    if (method === "UPSERT") {
      if (!id || data === undefined) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "id and data required" }) };
      }

      // Strip large images from settings to avoid payload size issues
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
        // Return the actual error so the frontend knows
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, status: sbRes.status, error: respText }) };
      }

      console.log("[DB UPSERT OK]", table, id);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // ── UPSERT_MANY ─────────────────────────────────────
    if (method === "UPSERT_MANY") {
      if (!Array.isArray(data)) return { statusCode: 400, headers, body: JSON.stringify({ error: "data must be array" }) };

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
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: respText }) };
      }

      console.log("[DB UPSERT_MANY OK]", table, rows.length, "rows");
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // ── DELETE ──────────────────────────────────────────
    if (method === "DELETE") {
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: "id required" }) };
      sbRes = await fetch(
        `${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(String(id))}`,
        { method: "DELETE", headers: sbHeaders }
      );
      respText = await sbRes.text();
      if (!sbRes.ok) console.error("[DB DELETE FAILED]", table, id, sbRes.status, respText);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: sbRes.ok }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown method: " + method }) };

  } catch(err) {
    console.error("[DB Proxy exception]", err.message, err.stack);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

// This file already handles all DB operations via the handler above
