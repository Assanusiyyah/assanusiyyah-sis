// ── Admission Candidate Portal — Cloudflare Pages Function ──
// Ported from netlify/functions/candidate-portal.js — logic unchanged. Public,
// unauthenticated entry point for a prospective student/parent to submit an
// admission application and get a Reference No. + PIN to check back later.
// Mirrors parent-login.js/parent-data.js: a candidate token is scoped to
// exactly one application row and never touches /api/db (which would expose
// every other family's application).
import crypto from "node:crypto";
import { signToken, requireAuth, hashPassword, verifyPassword } from "../_utils/auth.js";
import { checkLockout, recordFailure, recordSuccess } from "../_utils/rateLimit.js";
import { corsHeaders, jsonResponse } from "../_utils/cors.js";

async function fetchTable(env, sbHeaders, table, extraQuery) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?select=id,data&limit=5000${extraQuery || ""}`, { headers: sbHeaders });
  if (!resp.ok) { console.error("[CandidatePortal] fetch failed:", table, resp.status); return []; }
  const rows = await resp.json();
  return Array.isArray(rows) ? rows.map(function(r) { return r.data; }).filter(Boolean) : [];
}

// Single-row fetch by id — used once a candidate is authenticated and scoped
// to exactly one application, so we don't pull every other family's
// application (photos/documents included) just to find one row.
async function fetchRow(env, sbHeaders, table, id) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(String(id))}&select=id,data`, { headers: sbHeaders });
  if (!resp.ok) return null;
  const rows = await resp.json();
  return Array.isArray(rows) && rows[0] ? rows[0].data : null;
}

// Row count only (no `data` column) — used just to seed the reference-number
// sequence, so a new application no longer has to download every existing
// application's full record (photos/documents included) to submit.
async function countRows(env, sbHeaders, table) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?select=id&limit=5000`, { headers: sbHeaders });
  if (!resp.ok) return 0;
  const rows = await resp.json();
  return Array.isArray(rows) ? rows.length : 0;
}

async function upsertRow(env, sbHeaders, table, id, data) {
  const payload = { id: String(id), data: data, updated_at: new Date().toISOString() };
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: Object.assign({}, sbHeaders, { "Prefer": "resolution=merge-duplicates,return=minimal" }),
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

export async function onRequestOptions({ env }) {
  return new Response("", { status: 200, headers: corsHeaders(env, "Content-Type, Authorization") });
}

export async function onRequestPost({ request, env }) {
  const headers = corsHeaders(env, "Content-Type, Authorization");
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) return jsonResponse({ error: "Database not configured." }, 500, headers);

  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResponse({ error: "Invalid JSON" }, 400, headers); }

  const sbHeaders = { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY };

  try {
    // ── Submit a new application — public, no auth ──
    if (body.action === "apply") {
      const app = deepStripTags(body.application || {});
      if (!app.surname || !app.firstname) return jsonResponse({ error: "Student name is required." }, 400, headers);
      if (!app.dob) return jsonResponse({ error: "Date of birth is required." }, 400, headers);
      if (!app.parentName || !app.parentPhone) return jsonResponse({ error: "Parent/Guardian details are required." }, 400, headers);
      if (!app.declaration) return jsonResponse({ error: "Please confirm the declaration to submit." }, 400, headers);

      const existingCount = await countRows(env, sbHeaders, "admissions");
      const session = app.entrySession || "2025/2026";
      const refNo = genRefNo(session, existingCount);
      const pin = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit

      const id = crypto.randomUUID();
      const record = Object.assign({}, app, {
        id: id, refNo: refNo, pin: hashPassword(pin),
        status: "Pending", submittedAt: new Date().toISOString().slice(0, 10),
        reviewedBy: "", reviewedAt: "", remarks: "", admissionNo: ""
      });

      const saveResult = await upsertRow(env, sbHeaders, "admissions", id, record);
      if (!saveResult.ok) return jsonResponse({ error: "Could not save application: " + saveResult.error }, 500, headers);

      const token = signToken(env, { role: "candidate", applicationId: id }, 30 * 24 * 3600); // 30 days
      return jsonResponse({ success: true, token: token, refNo: refNo, pin: pin, application: sanitizeApplication(record) }, 200, headers);
    }

    // ── Log back in with Ref No. + PIN — public, no auth ──
    if (body.action === "login") {
      const refNo = String(body.refNo || "").trim().toUpperCase();
      const pin = String(body.pin || "").trim();
      if (!refNo || !pin) return jsonResponse({ success: false, error: "Reference number and PIN are required." }, 400, headers);

      const lockKey = "candidate:" + refNo;
      const lockout = await checkLockout(env, lockKey);
      if (lockout.blocked) {
        return jsonResponse({ success: false, error: "Too many failed attempts. Try again in " + Math.ceil(lockout.retryAfterSec / 60) + " minute(s)." }, 429, headers);
      }

      const applications = await fetchTable(env, sbHeaders, "admissions", "&data->>refNo=eq." + encodeURIComponent(refNo));
      const match = applications.find(function(a) { return String(a.refNo || "").toUpperCase() === refNo; });
      if (!match || !match.pin || !verifyPassword(pin, match.pin)) {
        await recordFailure(env, lockKey);
        return jsonResponse({ success: false, error: "Invalid reference number or PIN." }, 200, headers);
      }
      await recordSuccess(env, lockKey);

      const token = signToken(env, { role: "candidate", applicationId: match.id }, 30 * 24 * 3600);
      return jsonResponse({ success: true, token: token, application: sanitizeApplication(match) }, 200, headers);
    }

    // ── Everything else — candidate token, scoped to their own application ──
    const auth = requireAuth(env, request, { roles: ["candidate"] });
    if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status, headers);
    const applicationId = auth.payload.applicationId;

    if (body.action === "data") {
      const [app, gallery, allSettings] = await Promise.all([
        fetchRow(env, sbHeaders, "admissions", applicationId), fetchTable(env, sbHeaders, "gallery"), fetchTable(env, sbHeaders, "settings")
      ]);
      if (!app) return jsonResponse({ error: "Application not found" }, 404, headers);
      const calendarEvents = (allSettings[0] && allSettings[0].calendarEvents) || [];
      return jsonResponse({ application: sanitizeApplication(app), gallery: gallery, calendarEvents: calendarEvents }, 200, headers);
    }

    if (body.action === "update") {
      const app = await fetchRow(env, sbHeaders, "admissions", applicationId);
      if (!app) return jsonResponse({ error: "Application not found" }, 404, headers);
      if (app.status !== "Pending") return jsonResponse({ error: "This application has already been reviewed and can no longer be edited." }, 400, headers);

      const updates = deepStripTags(body.application || {});
      const merged = Object.assign({}, app, updates, {
        id: app.id, refNo: app.refNo, pin: app.pin, status: app.status,
        // Staff-only fields set through the admin review flow — a candidate's
        // own "update" call must never be able to forge these.
        admissionNo: app.admissionNo, reviewedBy: app.reviewedBy, reviewedAt: app.reviewedAt, remarks: app.remarks
      });
      const saveResult = await upsertRow(env, sbHeaders, "admissions", app.id, merged);
      if (!saveResult.ok) return jsonResponse({ error: "Could not save changes: " + saveResult.error }, 500, headers);
      return jsonResponse({ success: true, application: sanitizeApplication(merged) }, 200, headers);
    }

    return jsonResponse({ error: "Unknown action" }, 400, headers);

  } catch (err) {
    console.error("[CandidatePortal] Exception:", err.message);
    return jsonResponse({ error: err.message }, 500, headers);
  }
}
