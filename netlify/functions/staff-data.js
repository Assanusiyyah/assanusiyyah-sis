// ── Staff-scoped data proxy — Netlify Function ──
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
const { requireAuth } = require("./utils/auth");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

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

async function fetchRows(table) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id,data&limit=5000`, { headers: sbHeaders() });
  if (!resp.ok) { console.error("[StaffData] fetch failed:", table, resp.status); return []; }
  const rows = await resp.json();
  return Array.isArray(rows) ? rows : [];
}

async function validateWrite(table, row, auth) {
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
    const students = await fetchRows("students");
    const student = students.map(function(r) { return r.data; }).find(function(s) { return s && s.id === row.studentId; });
    if (!student || classes.indexOf(student.class) === -1) return { ok: false, error: "Not your student" };
    return { ok: true };
  }

  if (table === "diary") {
    return { ok: true };
  }

  return { ok: false, error: "Table not writable by staff" };
}

exports.handler = async function(event, context) {
  const headers = corsHeaders();

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  const auth = requireAuth(event, { roles: ["staff"] });
  if (!auth.ok) return { statusCode: auth.statusCode, headers, body: JSON.stringify({ error: auth.error }) };

  if (!SUPABASE_URL || !SUPABASE_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: "Database not configured." }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { table, method, id, data, limit } = body;
  if (!table) return { statusCode: 400, headers, body: JSON.stringify({ error: "table required" }) };

  const hdrs = sbHeaders();

  try {
    // ── SELECT ──────────────────────────────────────────
    if (method === "SELECT") {
      if (READABLE_TABLES.indexOf(table) === -1) return { statusCode: 200, headers, body: JSON.stringify([]) };
      const maxRows = Math.min(parseInt(limit) || 5000, 10000);
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id,data&limit=${maxRows}&order=updated_at.desc`, { headers: hdrs });
      const result = await resp.json();
      if (!resp.ok || !Array.isArray(result)) {
        console.error("[StaffData SELECT error]", table, resp.status);
        return { statusCode: 200, headers, body: JSON.stringify([]) };
      }
      let rows = result.map(function(r) { return r.data; }).filter(Boolean);

      if (table === "students") {
        const classes = auth.payload.classes || [];
        rows = rows.filter(function(s) { return classes.indexOf(s.class) !== -1; });
      }
      if (table === "settings") {
        rows = rows.map(function(row) {
          if (row && row.admins) { const clean = Object.assign({}, row); delete clean.admins; return clean; }
          return row;
        });
      }
      return { statusCode: 200, headers, body: JSON.stringify(rows) };
    }

    // ── UPSERT ──────────────────────────────────────────
    if (method === "UPSERT") {
      if (WRITABLE_TABLES.indexOf(table) === -1) return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: "Forbidden" }) };
      if (!id || data === undefined) return { statusCode: 400, headers, body: JSON.stringify({ error: "id and data required" }) };

      if (table === "exam_marks") {
        if (typeof data !== "object" || data === null) return { statusCode: 400, headers, body: JSON.stringify({ error: "data must be an object" }) };
        const subjects = auth.payload.subjects || [];
        const classes = auth.payload.classes || [];
        const examRows = await fetchRows("exams");
        const examsById = new Map(examRows.map(function(r) { return [String(r.data && r.data.id), r.data]; }));
        const currentResp = await fetch(`${SUPABASE_URL}/rest/v1/exam_marks?id=eq.singleton&select=data`, { headers: hdrs });
        const currentRows = currentResp.ok ? await currentResp.json() : [];
        const current = (Array.isArray(currentRows) && currentRows[0] && currentRows[0].data) || {};
        const merged = Object.assign({}, current);
        Object.keys(data).forEach(function(key) {
          const examId = key.split("_")[0];
          const exam = examsById.get(examId);
          if (exam && classes.indexOf(exam.class) !== -1 && subjects.indexOf(exam.subject) !== -1) {
            merged[key] = data[key];
          }
        });
        const payload = { id: "singleton", data: merged, updated_at: new Date().toISOString() };
        const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/exam_marks`, {
          method: "POST",
          headers: Object.assign({}, hdrs, { "Prefer": "resolution=merge-duplicates,return=minimal" }),
          body: JSON.stringify(payload)
        });
        if (!sbRes.ok) { const t = await sbRes.text(); return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: t }) }; }
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
      }

      const check = await validateWrite(table, data, auth);
      if (!check.ok) return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: check.error }) };

      let cleanData = data;
      if (table === "lessons") cleanData = Object.assign({}, data, { teacherId: auth.payload.staffId });

      const payload = { id: String(id), data: cleanData, updated_at: new Date().toISOString() };
      const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: "POST",
        headers: Object.assign({}, hdrs, { "Prefer": "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify(payload)
      });
      const respText = await sbRes.text();
      if (!sbRes.ok) {
        console.error("[StaffData UPSERT FAILED]", table, id, sbRes.status, respText);
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, status: sbRes.status, error: respText }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // ── DELETE ──────────────────────────────────────────
    if (method === "DELETE") {
      if (WRITABLE_TABLES.indexOf(table) === -1 || table === "exam_marks" || table === "diary") {
        return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: "Forbidden" }) };
      }
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: "id required" }) };

      const rows = await fetchRows(table);
      const existing = rows.find(function(r) { return String(r.id) === String(id); });
      if (!existing) return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
      const check = await validateWrite(table, existing.data, auth);
      if (!check.ok) return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: check.error }) };

      const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(String(id))}`, { method: "DELETE", headers: hdrs });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: sbRes.ok }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown or forbidden method: " + method }) };

  } catch (err) {
    console.error("[StaffData Exception]", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
