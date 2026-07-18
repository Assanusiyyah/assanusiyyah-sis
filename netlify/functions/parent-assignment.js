// ── Parent-side assignment submission — Netlify Function ──
// Lets a parent (on behalf of their child) submit an answer to a class
// assignment shown in the Parent Portal. Scoped to the one student in the
// token, same as parent-data.js / exam-attempt.js — never touches the
// generic /api/db proxy, so a parent token can't reach any other family's data.
const { requireAuth } = require("./utils/auth");
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
  if (!resp.ok) { console.error("[ParentAssignment] fetch failed:", table, resp.status); return []; }
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
    console.error("[ParentAssignment] upsert failed:", table, id, resp.status, t);
    return { ok: false, status: resp.status, error: t };
  }
  return { ok: true };
}

exports.handler = async function(event, context) {
  const headers = corsHeaders();
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  if (!SUPABASE_URL || !SUPABASE_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: "Database not configured." }) };

  const auth = requireAuth(event, { roles: ["parent"] });
  if (!auth.ok) return { statusCode: auth.statusCode, headers, body: JSON.stringify({ error: auth.error }) };
  const studentId = auth.payload.studentId;
  const studentClass = auth.payload.studentClass;

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  if (body.action !== "submit") return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action" }) };

  const assignmentId = body.assignmentId;
  const content = String(body.content || "").trim();
  if (!assignmentId) return { statusCode: 400, headers, body: JSON.stringify({ error: "assignmentId required" }) };
  if (!content) return { statusCode: 400, headers, body: JSON.stringify({ error: "Please write an answer before submitting." }) };

  try {
    const [assignments, lessons, submissions] = await Promise.all([
      fetchTable("assignments"),
      fetchTable("lessons"),
      fetchTable("submissions")
    ]);

    const asn = assignments.find(function(a) { return a.id === assignmentId; });
    if (!asn || asn.class !== studentClass) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Assignment not found" }) };
    }
    if (asn.targetStudentIds && asn.targetStudentIds.length && asn.targetStudentIds.indexOf(studentId) === -1) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "This assignment is not assigned to your child." }) };
    }

    const lesson = lessons.find(function(l) { return l.id === asn.lessonId; });
    const open = lesson ? lesson.submissionOpen !== false : asn.status !== "Closed";
    if (!open) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Submissions for this assignment are currently closed by the teacher." }) };
    }

    const existing = submissions.find(function(s) { return s.assignmentId === assignmentId && s.studentId === studentId; });
    if (existing) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "You have already submitted this assignment." }) };
    }

    const submission = {
      id: crypto.randomUUID(), assignmentId: assignmentId, studentId: studentId,
      submittedAt: new Date().toISOString().slice(0, 10), content: content,
      score: null, feedback: "", marked: false
    };
    const saveResult = await upsertRow("submissions", submission.id, submission);
    if (!saveResult.ok) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not save submission: " + saveResult.error }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, submission: submission }) };

  } catch (err) {
    console.error("[ParentAssignment] Exception:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
