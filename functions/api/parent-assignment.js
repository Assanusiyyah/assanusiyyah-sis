// ── Parent-side assignment submission — Cloudflare Pages Function ──
// Ported from netlify/functions/parent-assignment.js — logic unchanged.
import { requireAuth } from "../_utils/auth.js";
import { corsHeaders, jsonResponse } from "../_utils/cors.js";

function sbHeaders(env) {
  return { "Content-Type": "application/json", "apikey": env.SUPABASE_KEY, "Authorization": "Bearer " + env.SUPABASE_KEY };
}

async function fetchTable(env, table) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?select=id,data&limit=5000`, { headers: sbHeaders(env) });
  if (!resp.ok) { console.error("[ParentAssignment] fetch failed:", table, resp.status); return []; }
  const rows = await resp.json();
  return Array.isArray(rows) ? rows.map(function(r) { return r.data; }).filter(Boolean) : [];
}

async function upsertRow(env, table, id, data) {
  const payload = { id: String(id), data: data, updated_at: new Date().toISOString() };
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: Object.assign({}, sbHeaders(env), { "Prefer": "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const t = await resp.text();
    console.error("[ParentAssignment] upsert failed:", table, id, resp.status, t);
    return { ok: false, status: resp.status, error: t };
  }
  return { ok: true };
}

export async function onRequestOptions({ env }) {
  return new Response("", { status: 200, headers: corsHeaders(env, "Content-Type, Authorization") });
}

export async function onRequestPost({ request, env }) {
  const headers = corsHeaders(env, "Content-Type, Authorization");
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) return jsonResponse({ error: "Database not configured." }, 500, headers);

  const auth = requireAuth(env, request, { roles: ["parent"] });
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status, headers);
  const studentId = auth.payload.studentId;
  const studentClass = auth.payload.studentClass;

  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResponse({ error: "Invalid JSON" }, 400, headers); }

  if (body.action !== "submit") return jsonResponse({ error: "Unknown action" }, 400, headers);

  const assignmentId = body.assignmentId;
  const content = String(body.content || "").trim().replace(/[<>]/g, "");
  if (!assignmentId) return jsonResponse({ error: "assignmentId required" }, 400, headers);
  if (!content) return jsonResponse({ error: "Please write an answer before submitting." }, 400, headers);

  try {
    const [assignments, lessons, submissions] = await Promise.all([
      fetchTable(env, "assignments"),
      fetchTable(env, "lessons"),
      fetchTable(env, "submissions")
    ]);

    const asn = assignments.find(function(a) { return a.id === assignmentId; });
    if (!asn || asn.class !== studentClass) {
      return jsonResponse({ error: "Assignment not found" }, 404, headers);
    }
    if (asn.targetStudentIds && asn.targetStudentIds.length && asn.targetStudentIds.indexOf(studentId) === -1) {
      return jsonResponse({ error: "This assignment is not assigned to your child." }, 403, headers);
    }

    const lesson = lessons.find(function(l) { return l.id === asn.lessonId; });
    const open = lesson ? lesson.submissionOpen !== false : asn.status !== "Closed";
    if (!open) {
      return jsonResponse({ error: "Submissions for this assignment are currently closed by the teacher." }, 400, headers);
    }

    const existing = submissions.find(function(s) { return s.assignmentId === assignmentId && s.studentId === studentId; });
    if (existing) {
      return jsonResponse({ error: "You have already submitted this assignment." }, 400, headers);
    }

    const submission = {
      id: crypto.randomUUID(), assignmentId: assignmentId, studentId: studentId,
      submittedAt: new Date().toISOString().slice(0, 10), content: content,
      score: null, feedback: "", marked: false
    };
    const saveResult = await upsertRow(env, "submissions", submission.id, submission);
    if (!saveResult.ok) {
      return jsonResponse({ error: "Could not save submission: " + saveResult.error }, 500, headers);
    }

    return jsonResponse({ ok: true, submission: submission }, 200, headers);

  } catch (err) {
    console.error("[ParentAssignment] Exception:", err.message);
    return jsonResponse({ error: err.message }, 500, headers);
  }
}
