// ── Staff-scoped data proxy — Cloudflare Pages Function ──
// A "staff" token (issued by staff-login.js) can never reach the generic
// /api/db proxy (see the role check in db.js) because that proxy returns/
// writes whole tables with no per-row scoping. This endpoint is the staff
// equivalent: it accepts the SAME {table, method, id, data, limit} request
// shape the frontend's dbCall()/makeSynced() already send (see src/App.jsx),
// so every existing setStudents/setResults/setLessons/... call site in
// ResultsModule/LessonsModule/ExamModule/DiaryModule keeps working unchanged
// for a staff-role session — only the endpoint they're routed to differs
// (see the currentUser.role==="staff" branch of dbCall in src/App.jsx).
//
// Every write is validated server-side against the staff member's own
// `subjects`/`classes` (from their signed token, not anything client-
// supplied) — a staff token cannot write results/lessons/exams outside its
// own subject+class even if the browser client were bypassed entirely.
import { requireAuth } from "../_utils/auth.js";
import { corsHeaders, jsonResponse } from "../_utils/cors.js";

// Tables a staff session may SELECT. Anything else (fees, expenditure,
// messages, clinic, counselling, admissions, hostel_*, promotions, conduct,
// class_remarks, school_assets, admins_list) is out of scope for the staff
// portal's fixed permission set and stays unreachable here.
const READABLE_TABLES = [
  "students", "staff", "results", "lessons", "assignments", "submissions",
  "diary", "elibrary", "gallery", "exams", "exam_marks", "settings", "timetable"
];

// Tables a staff session may UPSERT — each validated against the token's own
// subjects/classes before the write is allowed (see validateWrite below).
// Deliberately excludes students/staff/settings/timetable/elibrary/gallery —
// none of those are staff-editable in the shared shell for this role.
const WRITABLE_TABLES = ["results", "lessons", "assignments", "submissions", "diary", "exams", "exam_marks"];

function sbHeaders(env) {
  return { "Content-Type": "application/json", "apikey": env.SUPABASE_KEY, "Authorization": "Bearer " + env.SUPABASE_KEY };
}

async function fetchRows(env, table) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?select=id,data&limit=5000`, { headers: sbHeaders(env) });
  if (!resp.ok) { console.error("[StaffData] fetch failed:", table, resp.status); return []; }
  const rows = await resp.json();
  return Array.isArray(rows) ? rows : [];
}

// Confirms a row (existing, for DELETE — or the client-submitted `data`, for
// UPSERT) actually belongs to this staff member's own subject+class before
// letting a write through. `diary`/`submissions` have their own rules below
// since they aren't subject/class-tagged the same way.
async function validateWrite(env, table, row, auth) {
  const subjects = auth.payload.subjects || [];
  const classes = auth.payload.classes || [];

  if (table === "results" || table === "lessons" || table === "exams") {
    if (!row || !row.class || !row.subject) return { ok: false, error: "class and subject required" };
    if (classes.indexOf(row.class) === -1 || subjects.indexOf(row.subject) === -1) {
      return { ok: false, error: "Not your subject/class" };
    }
    return { ok: true };
  }

  if (table === "assignments") {
    if (!row || !row.class) return { ok: false, error: "class required" };
    if (classes.indexOf(row.class) === -1) return { ok: false, error: "Not your class" };
    return { ok: true };
  }

  if (table === "submissions") {
    // Submissions carry a studentId, not a class/subject — allow marking any
    // submission for a student in one of this teacher's classes.
    const students = await fetchRows(env, "students");
    const student = students.map(r => r.data).find(s => s && s.id === row.studentId);
    if (!student || classes.indexOf(student.class) === -1) return { ok: false, error: "Not your student" };
    return { ok: true };
  }

  if (table === "diary") {
    // Diary is whole-school, not class/subject-scoped — any staff session
    // with the diary permission may add an entry (matches DiaryModule's
    // existing all-staff behavior for admin/Teacher accounts).
    return { ok: true };
  }

  return { ok: false, error: "Table not writable by staff" };
}

export async function onRequestOptions({ env }) {
  return new Response("", { status: 200, headers: corsHeaders(env, "Content-Type, Authorization") });
}

export async function onRequestPost({ request, env }) {
  const headers = corsHeaders(env, "Content-Type, Authorization");
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_KEY;

  const auth = requireAuth(env, request, { roles: ["staff"] });
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status, headers);

  if (!SUPABASE_URL || !SUPABASE_KEY) return jsonResponse({ error: "Database not configured." }, 500, headers);

  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResponse({ error: "Invalid JSON" }, 400, headers); }

  const { table, method, id, data, limit } = body;
  if (!table) return jsonResponse({ error: "table required" }, 400, headers);

  const hdrs = sbHeaders(env);

  try {
    // ── SELECT ──────────────────────────────────────────
    if (method === "SELECT") {
      if (READABLE_TABLES.indexOf(table) === -1) return jsonResponse([], 200, headers);
      const maxRows = Math.min(parseInt(limit) || 5000, 10000);
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id,data&limit=${maxRows}&order=updated_at.desc`, { headers: hdrs });
      const result = await resp.json();
      if (!resp.ok || !Array.isArray(result)) {
        console.error("[StaffData SELECT error]", table, resp.status);
        return jsonResponse([], 200, headers);
      }
      let rows = result.map(r => r.data).filter(Boolean);

      // Only expose students in the teacher's own classes — the one table
      // where trimming server-side is essentially free and meaningfully
      // reduces exposure vs. the full-school list an admin/Teacher account
      // gets through /api/db today.
      if (table === "students") {
        const classes = auth.payload.classes || [];
        rows = rows.filter(s => classes.indexOf(s.class) !== -1);
      }
      if (table === "settings") {
        rows = rows.map(row => {
          if (row && row.admins) { const clean = { ...row }; delete clean.admins; return clean; }
          return row;
        });
      }
      return jsonResponse(rows, 200, headers);
    }

    // ── UPSERT ──────────────────────────────────────────
    if (method === "UPSERT") {
      if (WRITABLE_TABLES.indexOf(table) === -1) return jsonResponse({ ok: false, error: "Forbidden" }, 403, headers);
      if (!id || data === undefined) return jsonResponse({ error: "id and data required" }, 400, headers);

      // exam_marks is a singleton row shared by every subject/class in the
      // school — never let a staff write blindly overwrite the whole thing.
      // Merge in only the examId_studentId keys that belong to exams within
      // this staff member's own subject+class.
      if (table === "exam_marks") {
        if (typeof data !== "object" || data === null) return jsonResponse({ error: "data must be an object" }, 400, headers);
        const subjects = auth.payload.subjects || [];
        const classes = auth.payload.classes || [];
        const examRows = await fetchRows(env, "exams");
        const examsById = new Map(examRows.map(r => [String(r.data && r.data.id), r.data]));
        const currentResp = await fetch(`${SUPABASE_URL}/rest/v1/exam_marks?id=eq.singleton&select=data`, { headers: hdrs });
        const currentRows = currentResp.ok ? await currentResp.json() : [];
        const current = (Array.isArray(currentRows) && currentRows[0] && currentRows[0].data) || {};
        const merged = { ...current };
        Object.keys(data).forEach(key => {
          const examId = key.split("_")[0];
          const exam = examsById.get(examId);
          if (exam && classes.indexOf(exam.class) !== -1 && subjects.indexOf(exam.subject) !== -1) {
            merged[key] = data[key];
          }
        });
        const payload = { id: "singleton", data: merged, updated_at: new Date().toISOString() };
        const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/exam_marks`, {
          method: "POST",
          headers: { ...hdrs, "Prefer": "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(payload)
        });
        if (!sbRes.ok) { const t = await sbRes.text(); return jsonResponse({ ok: false, error: t }, 200, headers); }
        return jsonResponse({ ok: true }, 200, headers);
      }

      const check = await validateWrite(env, table, data, auth);
      if (!check.ok) return jsonResponse({ ok: false, error: check.error }, 403, headers);

      // Lesson notes and exams are pinned to the authenticated staff member —
      // never trust a client-supplied teacherId/createdBy for these.
      let cleanData = data;
      if (table === "lessons") cleanData = { ...data, teacherId: auth.payload.staffId };

      const payload = { id: String(id), data: cleanData, updated_at: new Date().toISOString() };
      const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: "POST",
        headers: { ...hdrs, "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(payload)
      });
      const respText = await sbRes.text();
      if (!sbRes.ok) {
        console.error("[StaffData UPSERT FAILED]", table, id, sbRes.status, respText);
        return jsonResponse({ ok: false, status: sbRes.status, error: respText }, 200, headers);
      }
      return jsonResponse({ ok: true }, 200, headers);
    }

    // ── DELETE ──────────────────────────────────────────
    if (method === "DELETE") {
      if (WRITABLE_TABLES.indexOf(table) === -1 || table === "exam_marks" || table === "diary") {
        return jsonResponse({ ok: false, error: "Forbidden" }, 403, headers);
      }
      if (!id) return jsonResponse({ error: "id required" }, 400, headers);

      const rows = await fetchRows(env, table);
      const existing = rows.find(r => String(r.id) === String(id));
      if (!existing) return jsonResponse({ ok: true }, 200, headers); // already gone
      const check = await validateWrite(env, table, existing.data, auth);
      if (!check.ok) return jsonResponse({ ok: false, error: check.error }, 403, headers);

      const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(String(id))}`, { method: "DELETE", headers: hdrs });
      return jsonResponse({ ok: sbRes.ok }, 200, headers);
    }

    // UPSERT_MANY (bulk table-seeding) is an admin/init-time-only operation —
    // never available to a staff session.
    return jsonResponse({ error: "Unknown or forbidden method: " + method }, 400, headers);

  } catch (err) {
    console.error("[StaffData Exception]", err.message);
    return jsonResponse({ error: err.message }, 500, headers);
  }
}
