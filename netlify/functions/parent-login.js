// ── Parent Login — Netlify Function ──
// Verifies Admission No. + parent phone against Supabase server-side and
// issues a signed "parent" token scoped to exactly one student. The parent
// never gets a token that can read /api/db — that endpoint returns whole
// tables, which would leak every other family's grades/fees/health data.
// Use /api/parent-data (with this token) to fetch just this child's rows.
const { signToken } = require("./utils/auth");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function corsHeaders() {
  const isProd = process.env.CONTEXT === "production";
  const origin = (isProd && process.env.ALLOWED_ORIGIN) ? process.env.ALLOWED_ORIGIN : "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
}

function last10Digits(s) {
  return String(s || "").replace(/\D/g, "").slice(-10);
}

exports.handler = async function(event, context) {
  const headers = corsHeaders();

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { admissionNo, phone } = body;
  if (!admissionNo || !phone) {
    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: "Admission number and phone number required" }) };
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: "Database not configured." }) };
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
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: "DB error: " + resp.status }) };
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
      console.log("[ParentLogin] FAILED for:", admissionNo);
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: "Invalid Admission Number or Phone Number" }) };
    }

    const student = match.data;
    if (student.active === false) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: "This student's record is inactive. Please contact the school." }) };
    }

    const token = signToken({ role: "parent", studentId: student.id, studentClass: student.class }, 12 * 3600);

    console.log("[ParentLogin] SUCCESS for:", admissionNo);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, token: token, student: student }) };

  } catch (err) {
    console.error("[ParentLogin] Exception:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
