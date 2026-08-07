// ── Parent-scoped data — Cloudflare Pages Function ──
// Ported from netlify/functions/parent-data.js — logic unchanged, including
// the class-filtered students fetch.
import { requireAuth } from "../_utils/auth.js";
import { corsHeaders, jsonResponse } from "../_utils/cors.js";

async function fetchTable(env, sbHeaders, table, extraQuery) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?select=id,data&limit=5000${extraQuery || ""}`, { headers: sbHeaders });
  if (!resp.ok) { console.error("[ParentData] fetch failed:", table, resp.status); return []; }
  const rows = await resp.json();
  return Array.isArray(rows) ? rows.map(function(r) { return r.data; }).filter(Boolean) : [];
}

export async function onRequestOptions({ env }) {
  return new Response("", { status: 200, headers: corsHeaders(env, "Content-Type, Authorization") });
}

export async function onRequestPost({ request, env }) {
  const headers = corsHeaders(env, "Content-Type, Authorization");
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_KEY;

  const auth = requireAuth(env, request, { roles: ["parent"] });
  if (!auth.ok) {
    return jsonResponse({ error: auth.error }, auth.status, headers);
  }
  const studentId = auth.payload.studentId;
  const studentClass = auth.payload.studentClass;
  const studentArm = auth.payload.studentArm;
  if (!studentId) return jsonResponse({ error: "Token missing studentId" }, 400, headers);

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return jsonResponse({ error: "Database not configured." }, 500, headers);
  }

  const sbHeaders = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_KEY,
    "Authorization": "Bearer " + SUPABASE_KEY
  };

  try {
    const [allResults, allAttendance, allFees, diary, elibrary, allLessons, allAssignments, allSubmissions, allExams, gallery, allSettings, allStudents] = await Promise.all([
      fetchTable(env, sbHeaders, "results"),
      fetchTable(env, sbHeaders, "attendance"),
      fetchTable(env, sbHeaders, "fees"),
      fetchTable(env, sbHeaders, "diary"),
      fetchTable(env, sbHeaders, "elibrary"),
      fetchTable(env, sbHeaders, "lessons"),
      fetchTable(env, sbHeaders, "assignments"),
      fetchTable(env, sbHeaders, "submissions"),
      fetchTable(env, sbHeaders, "exams"),
      fetchTable(env, sbHeaders, "gallery"),
      fetchTable(env, sbHeaders, "settings"),
      fetchTable(env, sbHeaders, "students", "&data->>class=eq." + encodeURIComponent(studentClass || ""))
    ]);

    const resultsPublished = (allSettings[0] && allSettings[0].resultsPublished) || {};
    const isResultPublished = function(r) { return resultsPublished[r.session + "_" + r.term] !== false; };

    const results = allResults.filter(function(r) { return r.studentId === studentId; }).filter(isResultPublished);
    const attendance = allAttendance.filter(function(a) { return a.studentId === studentId; });
    const fees = allFees.filter(function(f) { return f.studentId === studentId; });
    const lessons = allLessons.filter(function(l) { return l.class === studentClass && l.status === "Published"; });
    const assignments = allAssignments.filter(function(a) {
      return a.class === studentClass && (!a.targetStudentIds || a.targetStudentIds.length === 0 || a.targetStudentIds.indexOf(studentId) !== -1);
    });
    const submissions = allSubmissions.filter(function(s) { return s.studentId === studentId; });

    const exams = allExams
      .filter(function(e) { return e.cbtActive && e.class === studentClass && (e.arm || "A") === (studentArm || "A"); })
      .map(function(e) {
        return { id: e.id, title: e.title, subject: e.subject, class: e.class, arm: e.arm, duration: e.duration, date: e.date, session: e.session, term: e.term };
      });

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

    return jsonResponse({ results, attendance, fees, diary, elibrary, lessons, assignments, submissions, exams, gallery, resultStats }, 200, headers);

  } catch (err) {
    console.error("[ParentData] Exception:", err.message);
    return jsonResponse({ error: err.message }, 500, headers);
  }
}
