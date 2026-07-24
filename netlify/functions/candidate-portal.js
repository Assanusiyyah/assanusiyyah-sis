// ── Admission Candidate Portal — Netlify Function ──
// Public, unauthenticated entry point for a prospective student/parent to
// submit an admission application and get a Reference No. + PIN to check
// back later. Mirrors parent-login.js/parent-data.js: a candidate token is
// scoped to exactly one application row and never touches /api/db (which
// would expose every other family's application).
const { signToken, requireAuth, hashPassword, verifyPassword } = require("./utils/auth");
const { checkLockout, recordFailure, recordSuccess } = require("./utils/rateLimit");
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

async function fetchTable(table, extraQuery) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id,data&limit=5000${extraQuery || ""}`, { headers: sbHeaders() });
  if (!resp.ok) { console.error("[CandidatePortal] fetch failed:", table, resp.status); return []; }
  const rows = await resp.json();
  return Array.isArray(rows) ? rows.map(function(r) { return r.data; }).filter(Boolean) : [];
}

// Single-row fetch by id — used once a candidate is authenticated and scoped
// to exactly one application, so we don't pull every other family's
// application (photos/documents included) just to find one row.
async function fetchRow(table, id) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(String(id))}&select=id,data`, { headers: sbHeaders() });
  if (!resp.ok) return null;
  const rows = await resp.json();
  return Array.isArray(rows) && rows[0] ? rows[0].data : null;
}

// Row count only (no `data` column) — used just to seed the reference-number
// sequence, so a new application no longer has to download every existing
// application's full record (photos/documents included) to submit.
async function countRows(table) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id&limit=5000`, { headers: sbHeaders() });
  if (!resp.ok) return 0;
  const rows = await resp.json();
  return Array.isArray(rows) ? rows.length : 0;
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

// Every field here ends up interpolated, unescaped, into printed HTML
// documents (admission letter, school bill, etc.) that staff open in a
// window sharing their authenticated session — so strip the characters
// needed to inject a tag/attribute before anything is ever stored.
function stripTags(v) {
  return String(v).replace(/[<>]/g, "");
}
function deepStripTags(value) {
  if (typeof value === "string") return stripTags(value);
  if (Array.isArray(value)) return value.map(deepStripTags);
  if (value && typeof value === "object") {
    const out = {};
    Object.keys(value).forEach(function(k) { out[k] = deepStripTags(value[k]); });
    return out;
  }
  return value;
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
      const app = deepStripTags(body.application || {});
      if (!app.surname || !app.firstname) return { statusCode: 400, headers, body: JSON.stringify({ error: "Student name is required." }) };
      if (!app.dob) return { statusCode: 400, headers, body: JSON.stringify({ error: "Date of birth is required." }) };
      if (!app.parentName || !app.parentPhone) return { statusCode: 400, headers, body: JSON.stringify({ error: "Parent/Guardian details are required." }) };
      if (!app.declaration) return { statusCode: 400, headers, body: JSON.stringify({ error: "Please confirm the declaration to submit." }) };

      const existingCount = await countRows("admissions");
      const session = app.entrySession || "2025/2026";
      const refNo = genRefNo(session, existingCount);
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

      const lockKey = "candidate:" + refNo;
      const lockout = await checkLockout(lockKey);
      if (lockout.blocked) {
        return { statusCode: 429, headers, body: JSON.stringify({ success: false, error: "Too many failed attempts. Try again in " + Math.ceil(lockout.retryAfterSec / 60) + " minute(s)." }) };
      }

      const applications = await fetchTable("admissions", "&data->>refNo=eq." + encodeURIComponent(refNo));
      const match = applications.find(function(a) { return String(a.refNo || "").toUpperCase() === refNo; });
      if (!match || !match.pin || !verifyPassword(pin, match.pin)) {
        await recordFailure(lockKey);
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: "Invalid reference number or PIN." }) };
      }
      await recordSuccess(lockKey);

      const token = signToken({ role: "candidate", applicationId: match.id }, 30 * 24 * 3600);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, token: token, application: sanitizeApplication(match) }) };
    }

    // ── Everything else — candidate token, scoped to their own application ──
    const auth = requireAuth(event, { roles: ["candidate"] });
    if (!auth.ok) return { statusCode: auth.statusCode, headers, body: JSON.stringify({ error: auth.error }) };
    const applicationId = auth.payload.applicationId;

    if (body.action === "data") {
      const [app, gallery, allSettings] = await Promise.all([
        fetchRow("admissions", applicationId), fetchTable("gallery"), fetchTable("settings")
      ]);
      if (!app) return { statusCode: 404, headers, body: JSON.stringify({ error: "Application not found" }) };
      const calendarEvents = (allSettings[0] && allSettings[0].calendarEvents) || [];
      return { statusCode: 200, headers, body: JSON.stringify({ application: sanitizeApplication(app), gallery: gallery, calendarEvents: calendarEvents }) };
    }

    if (body.action === "update") {
      const app = await fetchRow("admissions", applicationId);
      if (!app) return { statusCode: 404, headers, body: JSON.stringify({ error: "Application not found" }) };
      if (app.status !== "Pending") return { statusCode: 400, headers, body: JSON.stringify({ error: "This application has already been reviewed and can no longer be edited." }) };

      const updates = deepStripTags(body.application || {});
      const merged = Object.assign({}, app, updates, {
        id: app.id, refNo: app.refNo, pin: app.pin, status: app.status,
        // Staff-only fields set through the admin review flow — a candidate's
        // own "update" call must never be able to forge these.
        admissionNo: app.admissionNo, reviewedBy: app.reviewedBy, reviewedAt: app.reviewedAt, remarks: app.remarks
      });
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
