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
    const [allResults, allAttendance, allFees, diary, elibrary, allLessons, allAssignments, allSubmissions, allExams, gallery, allSettings, allStudents] = await Promise.all([
      fetchTable(sbHeaders, "results"),
      fetchTable(sbHeaders, "attendance"),
      fetchTable(sbHeaders, "fees"),
      fetchTable(sbHeaders, "diary"),
      fetchTable(sbHeaders, "elibrary"),
      fetchTable(sbHeaders, "lessons"),
      fetchTable(sbHeaders, "assignments"),
      fetchTable(sbHeaders, "submissions"),
      fetchTable(sbHeaders, "exams"),
      fetchTable(sbHeaders, "gallery"),
      fetchTable(sbHeaders, "settings"),
      fetchTable(sbHeaders, "students")
    ]);

    // A result is visible unless its session/term has been explicitly hidden
    // via Settings → Result Sheet Config → Result Visibility (default: visible,
    // so existing historical results never disappear just because the toggle
    // is new).
    const resultsPublished = (allSettings[0] && allSettings[0].resultsPublished) || {};
    const isResultPublished = function(r) { return resultsPublished[r.session + "_" + r.term] !== false; };

    const results = allResults.filter(function(r) { return r.studentId === studentId; }).filter(isResultPublished);
    const attendance = allAttendance.filter(function(a) { return a.studentId === studentId; });
    const fees = allFees.filter(function(f) { return f.studentId === studentId; });
    const lessons = allLessons.filter(function(l) { return l.class === studentClass && l.status === "Published"; });
    // Only class-wide assignments, or ones specifically targeted to this student
    // (see the "assign remedial work" tool in the Results module).
    const assignments = allAssignments.filter(function(a) {
      return a.class === studentClass && (!a.targetStudentIds || a.targetStudentIds.length === 0 || a.targetStudentIds.indexOf(studentId) !== -1);
    });
    const submissions = allSubmissions.filter(function(s) { return s.studentId === studentId; });

    // CBT exams: sanitized listing only — never send questions/answer keys here.
    // The real question set is fetched (and stripped of answers) server-side
    // by exam-attempt.js when the student actually starts the exam.
    const exams = allExams
      .filter(function(e) { return e.cbtActive && e.class === studentClass && (e.arm || "A") === (studentArm || "A"); })
      .map(function(e) {
        return { id: e.id, title: e.title, subject: e.subject, class: e.class, arm: e.arm, duration: e.duration, date: e.date, session: e.session, term: e.term };
      });

    // Position/class-average for the report-card print/share export. Only
    // aggregate numbers are computed and returned here — never another
    // student's name or scores — so this stays safe for a parent-scoped token.
    const classStudentIds = allStudents
      .filter(function(s) { return s.active && s.class === studentClass && (s.arm || "A") === (studentArm || "A"); })
      .map(function(s) { return s.id; });

    function classResultsFor(session, term) {
      return allResults.filter(function(r) { return r.class === studentClass && r.session === session && r.term === term && classStudentIds.indexOf(r.studentId) !== -1; });
    }

    const sessionTermKeys = Array.from(new Set(results.map(function(r) { return r.session + "|" + r.term; })));
    const resultStats = {};
    sessionTermKeys.forEach(function(key) {
      const parts = key.split("|");
      const session = parts[0], term = parts[1];
      const classResults = classResultsFor(session, term);
      const byStudent = {};
      classResults.forEach(function(r) {
        if (!byStudent[r.studentId]) byStudent[r.studentId] = [];
        byStudent[r.studentId].push(r.total || 0);
      });
      const studentAvgs = Object.keys(byStudent).map(function(sid) {
        const scores = byStudent[sid];
        return { sid: sid, avg: scores.reduce(function(a, b) { return a + b; }, 0) / scores.length };
      }).sort(function(a, b) { return b.avg - a.avg; });
      const myIdx = studentAvgs.findIndex(function(s) { return s.sid === studentId; });
      const avgs = studentAvgs.map(function(s) { return s.avg; });
      const overall = {
        position: myIdx >= 0 ? myIdx + 1 : null,
        classSize: studentAvgs.length,
        classAvg: avgs.length ? parseFloat((avgs.reduce(function(a, b) { return a + b; }, 0) / avgs.length).toFixed(2)) : null,
        classHighest: avgs.length ? parseFloat(avgs[0].toFixed(2)) : null,
        classLowest: avgs.length ? parseFloat(avgs[avgs.length - 1].toFixed(2)) : null
      };

      const subjectsInTerm = Array.from(new Set(classResults.map(function(r) { return r.subject; })));
      const subjects = {};
      subjectsInTerm.forEach(function(sub) {
        const subResults = classResults.filter(function(r) { return r.subject === sub; }).sort(function(a, b) { return (b.total || 0) - (a.total || 0); });
        const totals = subResults.map(function(r) { return r.total || 0; });
        const myPos = subResults.findIndex(function(r) { return r.studentId === studentId; });
        subjects[sub] = {
          avg: totals.length ? parseFloat((totals.reduce(function(a, b) { return a + b; }, 0) / totals.length).toFixed(1)) : 0,
          highest: totals.length ? Math.max.apply(null, totals) : 0,
          lowest: totals.length ? Math.min.apply(null, totals) : 0,
          position: myPos >= 0 ? myPos + 1 : null
        };
      });

      resultStats[key] = Object.assign({}, overall, { subjects: subjects });
    });

    return { statusCode: 200, headers, body: JSON.stringify({ results, attendance, fees, diary, elibrary, lessons, assignments, submissions, exams, gallery, resultStats }) };

  } catch (err) {
    console.error("[ParentData] Exception:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
