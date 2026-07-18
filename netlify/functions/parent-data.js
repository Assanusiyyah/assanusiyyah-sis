// ── Parent-scoped data — Netlify Function ──
// Given a valid "parent" token (issued by parent-login.js), returns only
// that one child's results/attendance/fees/submissions, published lesson
// notes and assignments for their class, plus the shared diary and
// elibrary tables. Never touches /api/db's ALLOWED_TABLES path, so a
// parent token can't be used to pull any other student's records.
const { requireAuth } = require("./utils/auth");

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

async function fetchTable(sbHeaders, table) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id,data&limit=5000`, { headers: sbHeaders });
  if (!resp.ok) { console.error("[ParentData] fetch failed:", table, resp.status); return []; }
  const rows = await resp.json();
  return Array.isArray(rows) ? rows.map(function(r) { return r.data; }).filter(Boolean) : [];
}

exports.handler = async function(event, context) {
  const headers = corsHeaders();

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  const auth = requireAuth(event, { roles: ["parent"] });
  if (!auth.ok) {
    return { statusCode: auth.statusCode, headers, body: JSON.stringify({ error: auth.error }) };
  }
  const studentId = auth.payload.studentId;
  const studentClass = auth.payload.studentClass;
  const studentArm = auth.payload.studentArm;
  if (!studentId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Token missing studentId" }) };

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Database not configured." }) };
  }

  const sbHeaders = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_KEY,
    "Authorization": "Bearer " + SUPABASE_KEY
  };

  try {
    const [allResults, allAttendance, allFees, diary, elibrary, allLessons, allAssignments, allSubmissions, allExams] = await Promise.all([
      fetchTable(sbHeaders, "results"),
      fetchTable(sbHeaders, "attendance"),
      fetchTable(sbHeaders, "fees"),
      fetchTable(sbHeaders, "diary"),
      fetchTable(sbHeaders, "elibrary"),
      fetchTable(sbHeaders, "lessons"),
      fetchTable(sbHeaders, "assignments"),
      fetchTable(sbHeaders, "submissions"),
      fetchTable(sbHeaders, "exams")
    ]);

    const results = allResults.filter(function(r) { return r.studentId === studentId; });
    const attendance = allAttendance.filter(function(a) { return a.studentId === studentId; });
    const fees = allFees.filter(function(f) { return f.studentId === studentId; });
    const lessons = allLessons.filter(function(l) { return l.class === studentClass && l.status === "Published"; });
    const assignments = allAssignments.filter(function(a) { return a.class === studentClass; });
    const submissions = allSubmissions.filter(function(s) { return s.studentId === studentId; });

    // CBT exams: sanitized listing only — never send questions/answer keys here.
    // The real question set is fetched (and stripped of answers) server-side
    // by exam-attempt.js when the student actually starts the exam.
    const exams = allExams
      .filter(function(e) { return e.cbtActive && e.class === studentClass && (e.arm || "A") === (studentArm || "A"); })
      .map(function(e) {
        return { id: e.id, title: e.title, subject: e.subject, class: e.class, arm: e.arm, duration: e.duration, date: e.date, session: e.session, term: e.term };
      });

    return { statusCode: 200, headers, body: JSON.stringify({ results, attendance, fees, diary, elibrary, lessons, assignments, submissions, exams }) };

  } catch (err) {
    console.error("[ParentData] Exception:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
