// ── Parent Login — Cloudflare Pages Function ──
// Ported from netlify/functions/parent-login.js — logic unchanged.
import { signToken } from "../_utils/auth.js";
import { checkLockout, recordFailure, recordSuccess } from "../_utils/rateLimit.js";
import { corsHeaders, jsonResponse } from "../_utils/cors.js";

function last10Digits(s) {
  return String(s || "").replace(/\D/g, "").slice(-10);
}

export async function onRequestOptions({ env }) {
  return new Response("", { status: 200, headers: corsHeaders(env) });
}

export async function onRequestPost({ request, env }) {
  const headers = corsHeaders(env);
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_KEY;

  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResponse({ error: "Invalid JSON" }, 400, headers); }

  const { admissionNo, phone } = body;
  if (!admissionNo || !phone) {
    return jsonResponse({ success: false, error: "Admission number and phone number required" }, 400, headers);
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return jsonResponse({ success: false, error: "Database not configured." }, 500, headers);
  }

  const lockKey = "parent:" + String(admissionNo).trim().toLowerCase();
  const lockout = await checkLockout(env, lockKey);
  if (lockout.blocked) {
    return jsonResponse({ success: false, error: "Too many failed attempts. Try again in " + Math.ceil(lockout.retryAfterSec / 60) + " minute(s)." }, 429, headers);
  }

  const sbHeaders = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_KEY,
    "Authorization": "Bearer " + SUPABASE_KEY
  };

  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/students?select=id,data&limit=5000`, { headers: sbHeaders });
    if (!resp.ok) {
      const err = await resp.text();
      console.error("[ParentLogin] Supabase fetch failed:", resp.status, err);
      return jsonResponse({ success: false, error: "DB error: " + resp.status }, 200, headers);
    }

    const rows = await resp.json();
    const wantedPhone = last10Digits(phone);

    const match = rows.find(function(row) {
      const s = row.data;
      if (!s || !s.admissionNo) return false;
      return s.admissionNo.toLowerCase() === String(admissionNo).toLowerCase() &&
        last10Digits(s.parentPhone) === wantedPhone;
    });

    if (!match) {
      await recordFailure(env, lockKey);
      console.log("[ParentLogin] FAILED for:", admissionNo);
      return jsonResponse({ success: false, error: "Invalid Admission Number or Phone Number" }, 200, headers);
    }

    const student = match.data;
    if (student.active === false) {
      return jsonResponse({ success: false, error: "This student's record is inactive. Please contact the school." }, 200, headers);
    }

    await recordSuccess(env, lockKey);
    const token = signToken(env, { role: "parent", studentId: student.id, studentClass: student.class, studentArm: student.arm }, 12 * 3600);

    console.log("[ParentLogin] SUCCESS for:", admissionNo);
    return jsonResponse({ success: true, token: token, student: student }, 200, headers);

  } catch (err) {
    console.error("[ParentLogin] Exception:", err.message);
    return jsonResponse({ error: err.message }, 500, headers);
  }
}
