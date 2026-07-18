// ── CBT Exam Attempts — Netlify Function ──
// Powers the online "AssanCBT" exam-taking flow referenced by the Exams
// module's "CBT Integration Ready" banner. A parent token (issued by
// parent-login.js, scoped to exactly one student) drives the exam-taking
// actions (start/answer/flag/submit); a staff token drives the teacher-facing
// suspicion report. The real answer key (exam.questions[].answer) is fetched
// here from Supabase but NEVER sent to the client — only sanitized question
// text/options go out, and grading happens server-side on submit.
const { requireAuth } = require("./utils/auth");
const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const COLUMN_MAX = { ca1: 20, ca2: 20, exam: 60 };

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
  if (!resp.ok) { console.error("[ExamAttempt] fetch failed:", table, resp.status); return []; }
  const rows = await resp.json();
  return Array.isArray(rows) ? rows.map(function(r) { return r.data; }).filter(Boolean) : [];
}

async function fetchRow(table, id) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(String(id))}&select=id,data`, { headers: sbHeaders() });
  if (!resp.ok) return null;
  const rows = await resp.json();
  return Array.isArray(rows) && rows[0] ? rows[0].data : null;
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
    console.error("[ExamAttempt] upsert failed:", table, id, resp.status, t);
    return { ok: false, status: resp.status, error: t };
  }
  return { ok: true };
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

function sanitizeQuestion(q) {
  return { id: q.id, text: q.text, marks: q.marks, type: q.type, optionA: q.optionA, optionB: q.optionB, optionC: q.optionC, optionD: q.optionD, image: q.image || "" };
}

function isStaffAllowed(payload) {
  if (payload.role === "root") return true;
  const perms = payload.permissions || [];
  return perms.indexOf("all") !== -1 || perms.indexOf("exams") !== -1;
}

exports.handler = async function(event, context) {
  const headers = corsHeaders();
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  if (!SUPABASE_URL || !SUPABASE_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: "Database not configured." }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const action = body.action;

  try {
    // ── Teacher/admin report — staff token ──────────────
    if (action === "report") {
      const auth = requireAuth(event, {});
      if (!auth.ok) return { statusCode: auth.statusCode, headers, body: JSON.stringify({ error: auth.error }) };
      if (!isStaffAllowed(auth.payload)) return { statusCode: 403, headers, body: JSON.stringify({ error: "Forbidden" }) };

      const examId = body.examId;
      if (!examId) return { statusCode: 400, headers, body: JSON.stringify({ error: "examId required" }) };

      const [allAttempts, students] = await Promise.all([fetchTable("exam_attempts"), fetchTable("students")]);
      const attempts = allAttempts.filter(function(a) { return a.examId === examId; });

      const enriched = attempts.map(function(a) {
        const stu = students.find(function(s) { return s.id === a.studentId; });
        const durationMinutes = a.submittedAt ? Math.round((new Date(a.submittedAt) - new Date(a.startedAt)) / 60000) : null;
        const suspicionScore = (a.pasteAttemptCount || 0) * 3 + (a.tabSwitchCount || 0) * 1;
        let flagLevel = "none";
        if (suspicionScore >= 15) flagLevel = "high";
        else if (suspicionScore >= 6) flagLevel = "medium";
        else if (suspicionScore >= 1) flagLevel = "low";
        return {
          attemptId: a.id,
          studentName: stu ? (stu.surname + " " + stu.firstname) : "Unknown",
          admissionNumber: stu ? stu.admissionNo : "—",
          tabSwitches: a.tabSwitchCount || 0,
          pasteAttempts: a.pasteAttemptCount || 0,
          durationMinutes: durationMinutes,
          status: a.submittedAt ? "submitted" : (a.isActive ? "in progress" : "abandoned"),
          score: a.score, maxScore: a.maxScore,
          suspicionScore: suspicionScore, flagLevel: flagLevel
        };
      }).sort(function(x, y) { return y.suspicionScore - x.suspicionScore; });

      return { statusCode: 200, headers, body: JSON.stringify({ attempts: enriched }) };
    }

    // ── Everything else — parent token, scoped to their own child ──────
    const auth = requireAuth(event, { roles: ["parent"] });
    if (!auth.ok) return { statusCode: auth.statusCode, headers, body: JSON.stringify({ error: auth.error }) };
    const studentId = auth.payload.studentId;

    if (action === "start") {
      const examId = body.examId;
      if (!examId) return { statusCode: 400, headers, body: JSON.stringify({ error: "examId required" }) };

      const [exam, student] = await Promise.all([fetchRow("exams", examId), fetchRow("students", studentId)]);
      if (!exam) return { statusCode: 404, headers, body: JSON.stringify({ error: "Exam not found" }) };
      if (!student) return { statusCode: 404, headers, body: JSON.stringify({ error: "Student not found" }) };
      if (!exam.cbtActive) return { statusCode: 400, headers, body: JSON.stringify({ error: "This exam is not available as a CBT exam." }) };
      if (exam.class !== student.class || (exam.arm || "A") !== (student.arm || "A")) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: "This exam is not for your child's class." }) };
      }

      const allAttempts = await fetchTable("exam_attempts");
      const existing = allAttempts.find(function(a) { return a.examId === examId && a.studentId === studentId && a.isActive; });
      if (existing) {
        const examQById = {};
        exam.questions.forEach(function(q) { examQById[q.id] = q; });
        const orderedQuestions = existing.questionOrder.map(function(qid) { return examQById[qid]; }).filter(Boolean).map(sanitizeQuestion);
        return { statusCode: 200, headers, body: JSON.stringify({
          resume: true, attemptId: existing.id, startedAt: existing.startedAt,
          effectiveDurationMinutes: existing.effectiveDurationMinutes, answers: existing.answers || {},
          questions: orderedQuestions, examTitle: exam.title, examSubject: exam.subject
        }) };
      }

      const objQuestions = exam.questions.filter(function(q) { return q.type === "objective"; });
      if (!objQuestions.length) return { statusCode: 400, headers, body: JSON.stringify({ error: "This exam has no objective questions available for CBT." }) };

      const shuffled = shuffle(objQuestions);
      const effectiveDuration = (parseInt(exam.duration) || 60) + (parseInt(student.examExtraMinutes) || 0);
      const attempt = {
        id: crypto.randomUUID(), examId: examId, studentId: studentId,
        questionOrder: shuffled.map(function(q) { return q.id; }),
        answers: {}, startedAt: new Date().toISOString(), submittedAt: null, isActive: true,
        tabSwitchCount: 0, pasteAttemptCount: 0, effectiveDurationMinutes: effectiveDuration,
        score: null, maxScore: shuffled.reduce(function(a, q) { return a + (parseFloat(q.marks) || 0); }, 0), graded: false
      };
      const saveResult = await upsertRow("exam_attempts", attempt.id, attempt);
      if (!saveResult.ok) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not save exam attempt (status " + saveResult.status + "): " + saveResult.error }) };
      }

      return { statusCode: 200, headers, body: JSON.stringify({
        resume: false, attemptId: attempt.id, startedAt: attempt.startedAt,
        effectiveDurationMinutes: effectiveDuration, answers: {},
        questions: shuffled.map(sanitizeQuestion), examTitle: exam.title, examSubject: exam.subject
      }) };
    }

    if (action === "answer" || action === "flag") {
      const attemptId = body.attemptId;
      if (!attemptId) return { statusCode: 400, headers, body: JSON.stringify({ error: "attemptId required" }) };
      const attempt = await fetchRow("exam_attempts", attemptId);
      if (!attempt || attempt.studentId !== studentId) return { statusCode: 404, headers, body: JSON.stringify({ error: "Attempt not found" }) };
      if (!attempt.isActive) return { statusCode: 400, headers, body: JSON.stringify({ error: "This attempt has already been submitted." }) };

      if (action === "answer") {
        const questionId = body.questionId;
        if (!questionId || attempt.questionOrder.indexOf(questionId) === -1) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid question" }) };
        }
        attempt.answers = Object.assign({}, attempt.answers, { [questionId]: body.value });
        const saveResult = await upsertRow("exam_attempts", attemptId, attempt);
        if (!saveResult.ok) return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not save answer: " + saveResult.error }) };
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
      }

      // flag
      const field = body.field;
      if (["tabSwitchCount", "pasteAttemptCount"].indexOf(field) === -1) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid field" }) };
      }
      attempt[field] = (attempt[field] || 0) + 1;
      const flagSaveResult = await upsertRow("exam_attempts", attemptId, attempt);
      if (!flagSaveResult.ok) return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not save flag: " + flagSaveResult.error }) };
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, count: attempt[field] }) };
    }

    if (action === "submit") {
      const attemptId = body.attemptId;
      if (!attemptId) return { statusCode: 400, headers, body: JSON.stringify({ error: "attemptId required" }) };
      const attempt = await fetchRow("exam_attempts", attemptId);
      if (!attempt || attempt.studentId !== studentId) return { statusCode: 404, headers, body: JSON.stringify({ error: "Attempt not found" }) };
      if (!attempt.isActive) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, alreadySubmitted: true, score: attempt.score, maxScore: attempt.maxScore }) };
      }

      const exam = await fetchRow("exams", attempt.examId);
      if (!exam) return { statusCode: 404, headers, body: JSON.stringify({ error: "Exam not found" }) };

      const examQById = {};
      exam.questions.forEach(function(q) { examQById[q.id] = q; });

      let objRaw = 0, objMaxPossible = 0, correctCount = 0;
      const questionMarks = {};
      attempt.questionOrder.forEach(function(qid) {
        const q = examQById[qid];
        if (!q) return;
        objMaxPossible += parseFloat(q.marks) || 0;
        const given = attempt.answers && attempt.answers[qid];
        const correct = given && String(given).trim().toUpperCase() === String(q.answer).trim().toUpperCase();
        const mark = correct ? (parseFloat(q.marks) || 0) : 0;
        if (correct) { objRaw += mark; correctCount++; }
        questionMarks[qid] = mark;
      });

      attempt.submittedAt = new Date().toISOString();
      attempt.isActive = false;
      attempt.score = objRaw;
      attempt.maxScore = objMaxPossible;
      attempt.correctCount = correctCount;
      attempt.totalCount = attempt.questionOrder.length;
      attempt.graded = true;
      const submitSaveResult = await upsertRow("exam_attempts", attemptId, attempt);
      if (!submitSaveResult.ok) return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not save submission: " + submitSaveResult.error }) };

      // Pre-fill the objective marks into the existing exam_marks singleton so
      // a teacher marking theory questions manually sees CBT answers already scored.
      const marksKey = attempt.examId + "_" + studentId;
      const singleton = (await fetchRow("exam_marks", "singleton")) || {};
      singleton[marksKey] = Object.assign({}, singleton[marksKey] || {}, questionMarks);
      await upsertRow("exam_marks", "singleton", singleton);

      const hasTheory = exam.questions.some(function(q) { return q.type === "theory"; });
      let autoPushed = false;

      if (!hasTheory) {
        const colMax = COLUMN_MAX[exam.column] || 60;
        const scaledScore = (exam.totalMarks && exam.totalMarks !== colMax)
          ? Math.round((objRaw / exam.totalMarks) * colMax * 10) / 10
          : objRaw;

        const student = await fetchRow("students", studentId);
        const allResults = await fetchTable("results");
        const existing = allResults.find(function(r) {
          return r.studentId === studentId && r.subject === exam.subject &&
            r.session === exam.session && r.term === exam.term && r.class === exam.class;
        });

        if (existing) {
          const updated = Object.assign({}, existing, { [exam.column]: Math.round(scaledScore) });
          updated.total = (updated.ca1 || 0) + (updated.ca2 || 0) + (updated.exam || 0);
          await upsertRow("results", updated.id, updated);
        } else {
          const newR = {
            id: crypto.randomUUID(), studentId: studentId, subject: exam.subject,
            class: exam.class, arm: exam.arm, session: exam.session, term: exam.term,
            ca1: 0, ca2: 0, exam: 0, total: 0,
            affectiveTraits: {}, psychomotorSkills: {},
            teacherComment: "", formMasterComment: "", principalComment: ""
          };
          newR[exam.column] = Math.round(scaledScore);
          newR.total = (newR.ca1 || 0) + (newR.ca2 || 0) + (newR.exam || 0);
          await upsertRow("results", newR.id, newR);
        }
        autoPushed = true;
      }

      return { statusCode: 200, headers, body: JSON.stringify({
        ok: true, score: objRaw, maxScore: objMaxPossible, correctCount: correctCount,
        totalCount: attempt.totalCount, autoPushed: autoPushed
      }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action: " + action }) };

  } catch (err) {
    console.error("[ExamAttempt] Exception:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
