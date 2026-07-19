// ── Admission Candidate Portal — Netlify Function ──
// Public, unauthenticated entry point for a prospective student/parent to
// submit an admission application and get a Reference No. + PIN to check
// back later. Mirrors parent-login.js/parent-data.js: a candidate token is
// scoped to exactly one application row and never touches /api/db (which
// would expose every other family's application).
const { signToken, requireAuth, hashPassword, verifyPassword } = require("./utils/auth");
const crypto = require("crypto");

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

function sbHeaders() {
  return { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY };
}

async function fetchTable(table) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id,data&limit=5000`, { headers: sbHeaders() });
  if (!resp.ok) { console.error("[CandidatePortal] fetch failed:", table, resp.status); return []; }
  const rows = await resp.json();
  return Array.isArray(rows) ? rows.map(function(r) { return r.data; }).filter(Boolean) : [];
}

async function upsertRow(table, id, data) {
  const payload = { id: String(id), data: data, updated_at: new Date().toISOString() };
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: Object.assign({}, sbHeaders(), { "Prefer": "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const t = await resp.text();
    console.error("[CandidatePortal] upsert failed:", table, id, resp.status, t);
    return { ok: false, error: t };
  }
  return { ok: true };
}

function genRefNo(session, seq) {
  return "ADM/" + String(session).split("/")[0] + "/" + String(1001 + seq).padStart(4, "0");
}

function sanitizeApplication(app) {
  const clean = Object.assign({}, app);
  delete clean.pin;
  return clean;
}

exports.handler = async function(event, context) {
  const headers = corsHeaders();
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  if (!SUPABASE_URL || !SUPABASE_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: "Database not configured." }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  try {
    // ── Submit a new application — public, no auth ──
    if (body.action === "apply") {
      const app = body.application || {};
      if (!app.surname || !app.firstname) return { statusCode: 400, headers, body: JSON.stringify({ error: "Student name is required." }) };
      if (!app.dob) return { statusCode: 400, headers, body: JSON.stringify({ error: "Date of birth is required." }) };
      if (!app.parentName || !app.parentPhone) return { statusCode: 400, headers, body: JSON.stringify({ error: "Parent/Guardian details are required." }) };
      if (!app.declaration) return { statusCode: 400, headers, body: JSON.stringify({ error: "Please confirm the declaration to submit." }) };

      const existing = await fetchTable("admissions");
      const session = app.entrySession || "2025/2026";
      const refNo = genRefNo(session, existing.length);
      const pin = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit

      const id = crypto.randomUUID();
      const record = Object.assign({}, app, {
        id: id, refNo: refNo, pin: hashPassword(pin),
        status: "Pending", submittedAt: new Date().toISOString().slice(0, 10),
        reviewedBy: "", reviewedAt: "", remarks: "", admissionNo: ""
      });

      const saveResult = await upsertRow("admissions", id, record);
      if (!saveResult.ok) return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not save application: " + saveResult.error }) };

      const token = signToken({ role: "candidate", applicationId: id }, 30 * 24 * 3600); // 30 days
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, token: token, refNo: refNo, pin: pin, application: sanitizeApplication(record) }) };
    }

    // ── Log back in with Ref No. + PIN — public, no auth ──
    if (body.action === "login") {
      const refNo = String(body.refNo || "").trim().toUpperCase();
      const pin = String(body.pin || "").trim();
      if (!refNo || !pin) return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: "Reference number and PIN are required." }) };

      const applications = await fetchTable("admissions");
      const match = applications.find(function(a) { return String(a.refNo || "").toUpperCase() === refNo; });
      if (!match || !match.pin || !verifyPassword(pin, match.pin)) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: "Invalid reference number or PIN." }) };
      }

      const token = signToken({ role: "candidate", applicationId: match.id }, 30 * 24 * 3600);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, token: token, application: sanitizeApplication(match) }) };
    }

    // ── Everything else — candidate token, scoped to their own application ──
    const auth = requireAuth(event, { roles: ["candidate"] });
    if (!auth.ok) return { statusCode: auth.statusCode, headers, body: JSON.stringify({ error: auth.error }) };
    const applicationId = auth.payload.applicationId;

    if (body.action === "data") {
      const [applications, gallery, allSettings] = await Promise.all([
        fetchTable("admissions"), fetchTable("gallery"), fetchTable("settings")
      ]);
      const app = applications.find(function(a) { return a.id === applicationId; });
      if (!app) return { statusCode: 404, headers, body: JSON.stringify({ error: "Application not found" }) };
      const calendarEvents = (allSettings[0] && allSettings[0].calendarEvents) || [];
      return { statusCode: 200, headers, body: JSON.stringify({ application: sanitizeApplication(app), gallery: gallery, calendarEvents: calendarEvents }) };
    }

    if (body.action === "update") {
      const applications = await fetchTable("admissions");
      const app = applications.find(function(a) { return a.id === applicationId; });
      if (!app) return { statusCode: 404, headers, body: JSON.stringify({ error: "Application not found" }) };
      if (app.status !== "Pending") return { statusCode: 400, headers, body: JSON.stringify({ error: "This application has already been reviewed and can no longer be edited." }) };

      const updates = body.application || {};
      const merged = Object.assign({}, app, updates, { id: app.id, refNo: app.refNo, pin: app.pin, status: app.status });
      const saveResult = await upsertRow("admissions", app.id, merged);
      if (!saveResult.ok) return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not save changes: " + saveResult.error }) };
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, application: sanitizeApplication(merged) }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action" }) };

  } catch (err) {
    console.error("[CandidatePortal] Exception:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
