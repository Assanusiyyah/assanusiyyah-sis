// ── CBT Exam Attempts — Cloudflare Pages Function ──
// Ported from netlify/functions/exam-attempt.js — logic unchanged. Powers the
// online "AssanCBT" exam-taking flow referenced by the Exams module's "CBT
// Integration Ready" banner. A parent token (issued by parent-login.js,
// scoped to exactly one student) drives the exam-taking actions
// (start/answer/flag/submit); a staff token drives the teacher-facing
// suspicion report. The real answer key (exam.questions[].answer) is fetched
// here from Supabase but NEVER sent to the client — only sanitized question
// text/options go out, and grading happens server-side on submit.
import crypto from "node:crypto";
import { requireAuth } from "../_utils/auth.js";
import { corsHeaders, jsonResponse } from "../_utils/cors.js";

const DEFAULT_COLUMN_MAX = { ca1: 20, ca2: 20, exam: 60 };

async function fetchTable(env, sbHeaders, table, extraQuery) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?select=id,data&limit=5000${extraQuery || ""}`, { headers: sbHeaders });
  if (!resp.ok) { console.error("[ExamAttempt] fetch failed:", table, resp.status); return []; }
  const rows = await resp.json();
  return Array.isArray(rows) ? rows.map(function(r) { return r.data; }).filter(Boolean) : [];
}

async function fetchRow(env, sbHeaders, table, id) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(String(id))}&select=id,data`, { headers: sbHeaders });
  if (!resp.ok) return null;
  const rows = await resp.json();
  return Array.isArray(rows) && rows[0] ? rows[0].data : null;
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
  const action = body.action;

  try {
    // ── Teacher/admin report — staff token ──────────────
    if (action === "report") {
      const auth = requireAuth(env, request, {});
      if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status, headers);
      if (!isStaffAllowed(auth.payload)) return jsonResponse({ error: "Forbidden" }, 403, headers);

      const examId = body.examId;
      if (!examId) return jsonResponse({ error: "examId required" }, 400, headers);

      // Filtering server-side (rather than pulling every attempt/student ever
      // recorded school-wide) matters a lot here: exam_attempts only grows,
      // and students carries every student's compressed photo.
      const attempts = await fetchTable(env, sbHeaders, "exam_attempts", "&data->>examId=eq." + encodeURIComponent(examId));
      const studentIds = Array.from(new Set(attempts.map(function(a) { return a.studentId; }).filter(Boolean)));
      const students = studentIds.length
        ? await fetchTable(env, sbHeaders, "students", "&id=in.(" + studentIds.map(encodeURIComponent).join(",") + ")")
        : [];

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

      return jsonResponse({ attempts: enriched }, 200, headers);
    }

    // ── Everything else — parent token, scoped to their own child ──────
    const auth = requireAuth(env, request, { roles: ["parent"] });
    if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status, headers);
    const studentId = auth.payload.studentId;

    if (action === "start") {
      const examId = body.examId;
      if (!examId) return jsonResponse({ error: "examId required" }, 400, headers);

      const [exam, student] = await Promise.all([fetchRow(env, sbHeaders, "exams", examId), fetchRow(env, sbHeaders, "students", studentId)]);
      if (!exam) return jsonResponse({ error: "Exam not found" }, 404, headers);
      if (!student) return jsonResponse({ error: "Student not found" }, 404, headers);
      if (!exam.cbtActive) return jsonResponse({ error: "This exam is not available as a CBT exam." }, 400, headers);
      if (exam.class !== student.class || (exam.arm || "A") !== (student.arm || "A")) {
        return jsonResponse({ error: "This exam is not for your child's class." }, 403, headers);
      }

      // Only this student's attempts at this exam are relevant here — no need
      // to pull every attempt ever made school-wide (exam_attempts only grows).
      const ownAttempts = await fetchTable(env, sbHeaders, "exam_attempts", "&data->>examId=eq." + encodeURIComponent(examId) + "&data->>studentId=eq." + encodeURIComponent(studentId));
      const existing = ownAttempts.find(function(a) { return a.isActive; });
      if (existing) {
        const examQById = {};
        exam.questions.forEach(function(q) { examQById[q.id] = q; });
        const orderedQuestions = existing.questionOrder.map(function(qid) { return examQById[qid]; }).filter(Boolean).map(sanitizeQuestion);
        return jsonResponse({
          resume: true, attemptId: existing.id, startedAt: existing.startedAt,
          effectiveDurationMinutes: existing.effectiveDurationMinutes, answers: existing.answers || {},
          questions: orderedQuestions, examTitle: exam.title, examSubject: exam.subject
        }, 200, headers);
      }

      const objQuestions = exam.questions.filter(function(q) { return q.type === "objective"; });
      if (!objQuestions.length) return jsonResponse({ error: "This exam has no objective questions available for CBT." }, 400, headers);

      const shuffled = shuffle(objQuestions);
      const effectiveDuration = (parseInt(exam.duration) || 60) + (parseInt(student.examExtraMinutes) || 0);
      const attempt = {
        id: crypto.randomUUID(), examId: examId, studentId: studentId,
        questionOrder: shuffled.map(function(q) { return q.id; }),
        answers: {}, startedAt: new Date().toISOString(), submittedAt: null, isActive: true,
        tabSwitchCount: 0, pasteAttemptCount: 0, effectiveDurationMinutes: effectiveDuration,
        score: null, maxScore: shuffled.reduce(function(a, q) { return a + (parseFloat(q.marks) || 0); }, 0), graded: false
      };
      const saveResult = await upsertRow(env, sbHeaders, "exam_attempts", attempt.id, attempt);
      if (!saveResult.ok) {
        return jsonResponse({ error: "Could not save exam attempt (status " + saveResult.status + "): " + saveResult.error }, 500, headers);
      }

      return jsonResponse({
        resume: false, attemptId: attempt.id, startedAt: attempt.startedAt,
        effectiveDurationMinutes: effectiveDuration, answers: {},
        questions: shuffled.map(sanitizeQuestion), examTitle: exam.title, examSubject: exam.subject
      }, 200, headers);
    }

    if (action === "answer" || action === "flag") {
      const attemptId = body.attemptId;
      if (!attemptId) return jsonResponse({ error: "attemptId required" }, 400, headers);
      const attempt = await fetchRow(env, sbHeaders, "exam_attempts", attemptId);
      if (!attempt || attempt.studentId !== studentId) return jsonResponse({ error: "Attempt not found" }, 404, headers);
      if (!attempt.isActive) return jsonResponse({ error: "This attempt has already been submitted." }, 400, headers);

      if (action === "answer") {
        const questionId = body.questionId;
        if (!questionId || attempt.questionOrder.indexOf(questionId) === -1) {
          return jsonResponse({ error: "Invalid question" }, 400, headers);
        }
        attempt.answers = Object.assign({}, attempt.answers, { [questionId]: body.value });
        const saveResult = await upsertRow(env, sbHeaders, "exam_attempts", attemptId, attempt);
        if (!saveResult.ok) return jsonResponse({ error: "Could not save answer: " + saveResult.error }, 500, headers);
        return jsonResponse({ ok: true }, 200, headers);
      }

      // flag
      const field = body.field;
      if (["tabSwitchCount", "pasteAttemptCount"].indexOf(field) === -1) {
        return jsonResponse({ error: "Invalid field" }, 400, headers);
      }
      attempt[field] = (attempt[field] || 0) + 1;
      const flagSaveResult = await upsertRow(env, sbHeaders, "exam_attempts", attemptId, attempt);
      if (!flagSaveResult.ok) return jsonResponse({ error: "Could not save flag: " + flagSaveResult.error }, 500, headers);
      return jsonResponse({ ok: true, count: attempt[field] }, 200, headers);
    }

    if (action === "submit") {
      const attemptId = body.attemptId;
      if (!attemptId) return jsonResponse({ error: "attemptId required" }, 400, headers);
      const attempt = await fetchRow(env, sbHeaders, "exam_attempts", attemptId);
      if (!attempt || attempt.studentId !== studentId) return jsonResponse({ error: "Attempt not found" }, 404, headers);
      if (!attempt.isActive) {
        return jsonResponse({ ok: true, alreadySubmitted: true, score: attempt.score, maxScore: attempt.maxScore }, 200, headers);
      }

      const exam = await fetchRow(env, sbHeaders, "exams", attempt.examId);
      if (!exam) return jsonResponse({ error: "Exam not found" }, 404, headers);

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
      const submitSaveResult = await upsertRow(env, sbHeaders, "exam_attempts", attemptId, attempt);
      if (!submitSaveResult.ok) return jsonResponse({ error: "Could not save submission: " + submitSaveResult.error }, 500, headers);

      // Pre-fill the objective marks into the existing exam_marks singleton so
      // a teacher marking theory questions manually sees CBT answers already scored.
      const marksKey = attempt.examId + "_" + studentId;
      const singleton = (await fetchRow(env, sbHeaders, "exam_marks", "singleton")) || {};
      singleton[marksKey] = Object.assign({}, singleton[marksKey] || {}, questionMarks);
      await upsertRow(env, sbHeaders, "exam_marks", "singleton", singleton);

      const hasTheory = exam.questions.some(function(q) { return q.type === "theory"; });
      let autoPushed = false;

      if (!hasTheory) {
        const settings = (await fetchRow(env, sbHeaders, "settings", "singleton")) || {};
        const rc = settings.resultConfig || {};
        const columnMax = { ca1: rc.ca1Max || DEFAULT_COLUMN_MAX.ca1, ca2: rc.ca2Max || DEFAULT_COLUMN_MAX.ca2, exam: rc.examMax || DEFAULT_COLUMN_MAX.exam };
        const colMax = columnMax[exam.column] || 60;
        const scaledScore = (exam.totalMarks && exam.totalMarks !== colMax)
          ? Math.round((objRaw / exam.totalMarks) * colMax * 10) / 10
          : objRaw;

        // Narrow to this one student+subject+term server-side — `results`
        // accumulates every score for every student across every session,
        // and the old code pulled the whole thing just to find one row.
        const ownResults = await fetchTable(env, sbHeaders, "results",
          "&data->>studentId=eq." + encodeURIComponent(studentId) +
          "&data->>subject=eq." + encodeURIComponent(exam.subject) +
          "&data->>session=eq." + encodeURIComponent(exam.session) +
          "&data->>term=eq." + encodeURIComponent(exam.term) +
          "&data->>class=eq." + encodeURIComponent(exam.class));
        const existing = ownResults[0];

        if (existing) {
          const updated = Object.assign({}, existing, { [exam.column]: Math.round(scaledScore) });
          updated.total = (updated.ca1 || 0) + (updated.ca2 || 0) + (updated.exam || 0);
          await upsertRow(env, sbHeaders, "results", updated.id, updated);
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
          await upsertRow(env, sbHeaders, "results", newR.id, newR);
        }
        autoPushed = true;
      }

      return jsonResponse({
        ok: true, score: objRaw, maxScore: objMaxPossible, correctCount: correctCount,
        totalCount: attempt.totalCount, autoPushed: autoPushed
      }, 200, headers);
    }

    return jsonResponse({ error: "Unknown action: " + action }, 400, headers);

  } catch (err) {
    console.error("[ExamAttempt] Exception:", err.message);
    return jsonResponse({ error: err.message }, 500, headers);
  }
}
