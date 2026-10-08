// ── ScholaByte inside the SIS — Netlify Function ──
// Same logic as functions/api/scholabyte.js (the Cloudflare Pages version);
// keep the two in step. See that file for the full description.
//   keys / load / save / report — POST JSON {action, ...} with a Bearer token.
// Env: SCHOLABYTE_KEYS (JSON of base64 AES keys), SUPABASE_URL, SUPABASE_KEY.
const { requireAuth } = require("./utils/auth");

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

const CLASS_ORDER = ["JSS1", "JSS2", "JSS3", "SS1", "SS2", "SS3"];
const MAX_STATE_BYTES = 3 * 1024 * 1024;

function sbHeaders(env) {
  return { "Content-Type": "application/json", "apikey": env.SUPABASE_KEY, "Authorization": "Bearer " + env.SUPABASE_KEY };
}

async function getRow(env, table, id) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&select=id,data`, { headers: sbHeaders(env) });
  if (!r.ok) throw new Error(table + " read failed: " + r.status);
  const rows = await r.json();
  return rows && rows[0] ? rows[0].data : null;
}

// Who is asking, and which classes they may open.
async function identify(env, payload) {
  if (payload.role === "parent") {
    const stu = await getRow(env, "students", String(payload.studentId));
    if (!stu || stu.active === false) return { error: "Student record not found or inactive." };
    const cls = String(stu.class || "").replace(/\s+/g, "").toUpperCase();
    const idx = CLASS_ORDER.indexOf(cls);
    return {
      owner: "stu:" + stu.id, kind: "student",
      name: ((stu.surname || "") + " " + (stu.firstname || "")).trim(),
      class: stu.class || "", arm: stu.arm || "", admissionNo: stu.admissionNo || "",
      classes: idx >= 0 ? CLASS_ORDER.slice(0, idx + 1) : []
    };
  }
  if (payload.role === "staff") {
    return { owner: "staff:" + payload.staffId, kind: "staff", name: "", classes: CLASS_ORDER.slice() };
  }
  if (payload.role === "candidate") return { error: "Forbidden" };
  // admin / root / other admin-account roles
  return { owner: "admin:" + (payload.sub || payload.username), kind: "admin", name: payload.username || "", classes: CLASS_ORDER.slice() };
}

function parseJson(s, fallback) { try { const v = JSON.parse(s); return v == null ? fallback : v; } catch (e) { return fallback; } }

// Small summary for the teacher view, derived from the saved localStorage snapshot.
function summarise(state) {
  const results = parseJson(state["cbt_exam-results"], []);
  const list = Array.isArray(results) ? results.filter(function (r) { return r && r.total; }) : [];
  const recent = list.slice(-30).map(function (r) {
    return { subject: r.subject || "", cls: r["class"] || "", mode: r.mode || "", score: r.score, total: r.total, at: r.timestamp || null };
  });
  const pct = list.length ? Math.round(list.reduce(function (a, r) { return a + (r.score / r.total); }, 0) / list.length * 100) : null;
  const stats = parseJson(state["abk-topic-stats"], {});
  const weak = Object.keys(stats || {}).map(function (k) { const s = stats[k] || {}; return { topic: k, ok: s.ok || 0, n: s.n || 0 }; })
    .filter(function (t) { return t.n >= 3 && t.ok / t.n < 0.6; })
    .sort(function (a, b) { return a.ok / a.n - b.ok / b.n; }).slice(0, 10);
  const prog = parseJson(state["abk-textbook-progress"], {});
  let topicsRead = 0;
  Object.keys(prog || {}).forEach(function (k) { if (prog[k] && prog[k].read) topicsRead++; });
  return { tests: list.length, avgPct: pct, recent: recent, weak: weak, topicsRead: topicsRead };
}

exports.handler = async function(event) {
  const headers = corsHeaders();
  const resp = function(obj, status) { return { statusCode: status || 200, headers: headers, body: JSON.stringify(obj) }; };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: headers, body: "" };
  if (event.httpMethod !== "POST") return resp({ error: "Method not allowed" }, 405);
  const env = process.env;
  const auth = requireAuth(event, {});
  if (!auth.ok) return resp({ error: auth.error }, auth.statusCode);
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) return resp({ error: "Database not configured." }, 500);

  const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : (event.body || "");
  if (raw.length > MAX_STATE_BYTES + 4096) return resp({ error: "Progress data too large." }, 413);
  let body;
  try { body = JSON.parse(raw || "{}"); } catch (e) { return resp({ error: "Invalid JSON" }, 400); }

  try {
    const who = await identify(env, auth.payload);
    if (who.error) return resp({ error: who.error }, 403);

    if (body.action === "keys") {
      let all;
      try { all = JSON.parse(env.SCHOLABYTE_KEYS || "null"); } catch (e) { all = null; }
      if (!all || !all.shell) return resp({ error: "ScholaByte is not set up on this server yet." }, 503);
      const keys = { shell: all.shell };
      who.classes.forEach(function (c) { if (all[c]) keys[c] = all[c]; });
      return resp({ classes: who.classes, keys: keys, who: { owner: who.owner, kind: who.kind, name: who.name, class: who.class || "" } }, 200);
    }

    if (body.action === "load") {
      const row = await getRow(env, "scholabyte_progress", who.owner);
      return resp({ state: row ? row.state || {} : {}, savedAt: row ? row.savedAt || 0 : 0 }, 200);
    }

    if (body.action === "save") {
      const state = body.state && typeof body.state === "object" ? body.state : null;
      if (!state) return resp({ error: "state required" }, 400);
      const clean = {};
      Object.keys(state).forEach(function (k) {
        if (/^(cbt_|abk-)/.test(k) && typeof state[k] === "string") clean[k] = state[k];
      });
      const savedAt = Date.now();
      const data = {
        owner: who.owner, kind: who.kind, name: who.name, class: who.class || "", arm: who.arm || "",
        admissionNo: who.admissionNo || "", state: clean, summary: summarise(clean), savedAt: savedAt
      };
      const r = await fetch(`${env.SUPABASE_URL}/rest/v1/scholabyte_progress`, {
        method: "POST",
        headers: Object.assign({}, sbHeaders(env), { "Prefer": "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify({ id: who.owner, data: data, updated_at: new Date(savedAt).toISOString() })
      });
      if (!r.ok) { console.error("[ScholaByte] save failed", r.status, await r.text()); return resp({ error: "Could not save progress." }, 502); }
      return resp({ ok: true, savedAt: savedAt }, 200);
    }

    if (body.action === "report") {
      if (who.kind === "student") return resp({ error: "Forbidden" }, 403);
      const r = await fetch(`${env.SUPABASE_URL}/rest/v1/scholabyte_progress?select=id,data->owner,data->kind,data->name,data->class,data->arm,data->admissionNo,data->summary,data->savedAt&id=like.stu:*&limit=5000`, { headers: sbHeaders(env) });
      if (!r.ok) { console.error("[ScholaByte] report failed", r.status, await r.text()); return resp({ error: "Could not read progress." }, 502); }
      return resp({ rows: await r.json() }, 200);
    }

    return resp({ error: "Unknown action" }, 400);
  } catch (err) {
    console.error("[ScholaByte]", err.message);
    return resp({ error: err.message }, 500);
  }
};
