// ── Staff Login — Netlify Function ──
// Lets a registered staff member (the `staff` table, managed in the Staff
// module) log in without a separate admins_list account. Username is the
// `username` field stored on their staff record (surname, collision-suffixed
// with their id if another staff member shares the surname — see StaffModule);
// password is simply their staff record's own `id`. There is no separate
// credential to manage — the record IS the login.
const { signToken } = require("./utils/auth");
const { checkLockout, recordFailure, recordSuccess } = require("./utils/rateLimit");

// Fixed permission set for every staff-role login — dashboard, eLibrary,
// read-only gallery, and their own subject/class-scoped results/lessons/exams,
// plus the school diary and calendar. Never "all" — staff tokens are also
// walled off from /api/db entirely (see netlify/functions/db.js), so this list
// only controls sidebar/routing, not a real security boundary by itself.
const STAFF_PERMISSIONS = ["dashboard", "elibrary", "gallery", "results", "lessons", "exams", "diary", "calendar"];

// Mirrors computeStaffUsername() in src/App.jsx (StaffModule). Staff created
// before that field existed have no stored `username` on their record — this
// derives what it WOULD be so those legacy records can still log in, instead
// of requiring an admin to open and re-save every existing staff member first.
function computeUsername(surname, id, allStaff, excludeId) {
  var base = String(surname || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  var collides = (allStaff || []).some(function(s) {
    return s.id !== excludeId && (s.username ? s.username === base : computeUsernameBase(s.surname) === base);
  });
  return collides ? (base + "-" + String(id).toLowerCase()) : base;
}
function computeUsernameBase(surname) {
  return String(surname || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

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

exports.handler = async function(event, context) {
  const headers = corsHeaders();

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { username, password } = body;
  if (!username || !password) {
    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: "Username and password required" }) };
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: "Database not configured." }) };
  }

  const wantedUsername = String(username).trim().toLowerCase();
  const lockKey = "staff:" + wantedUsername;
  const lockout = await checkLockout(lockKey);
  if (lockout.blocked) {
    return { statusCode: 429, headers, body: JSON.stringify({ success: false, error: "Too many failed attempts. Try again in " + Math.ceil(lockout.retryAfterSec / 60) + " minute(s)." }) };
  }

  const sbHeaders = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_KEY,
    "Authorization": "Bearer " + SUPABASE_KEY
  };

  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/staff?select=id,data&limit=2000`, { headers: sbHeaders });
    if (!resp.ok) {
      const err = await resp.text();
      console.error("[StaffLogin] Supabase fetch failed:", resp.status, err);
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: "DB error: " + resp.status }) };
    }

    const rows = await resp.json();
    const wantedPassword = String(password).trim().toUpperCase();
    const allStaffData = rows.map(function(r) { return r.data; }).filter(Boolean);

    const match = rows.find(function(row) {
      const s = row.data;
      if (!s) return false;
      const effectiveUsername = s.username || computeUsername(s.surname, s.id, allStaffData, s.id);
      return String(effectiveUsername).toLowerCase() === wantedUsername &&
        String(s.id || "").toUpperCase() === wantedPassword;
    });

    if (!match) {
      await recordFailure(lockKey);
      console.log("[StaffLogin] FAILED for:", username);
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: "Invalid username or password" }) };
    }

    const staff = match.data;
    if (staff.active === false) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: "Account deactivated" }) };
    }

    // Self-heal: a legacy record with no stored username gets one written
    // now that it's confirmed (matched a real login), so future logins hit
    // the fast/simple exact-match path and the ID card / profile UI has a
    // real value to display instead of recomputing it every time.
    const effectiveUsername = staff.username || computeUsername(staff.surname, staff.id, allStaffData, staff.id);
    if (!staff.username) {
      const healed = Object.assign({}, staff, { username: effectiveUsername });
      fetch(`${SUPABASE_URL}/rest/v1/staff`, {
        method: "POST",
        headers: Object.assign({}, sbHeaders, { "Prefer": "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify({ id: String(staff.id), data: healed, updated_at: new Date().toISOString() })
      }).catch(function(e) { console.error("[StaffLogin] username backfill failed:", e.message); });
    }

    await recordSuccess(lockKey);
    const token = signToken({
      role: "staff",
      staffId: staff.id,
      subjects: staff.subjects || [],
      classes: staff.classes || []
    }, 12 * 3600);

    const admin = {
      id: staff.id,
      staffId: staff.id,
      name: (staff.surname + " " + staff.firstname).trim(),
      username: effectiveUsername,
      role: "staff",
      permissions: STAFF_PERMISSIONS,
      subjects: staff.subjects || [],
      classes: staff.classes || [],
      active: staff.active !== false
    };

    console.log("[StaffLogin] SUCCESS for:", username);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, token: token, admin: admin }) };

  } catch (err) {
    console.error("[StaffLogin] Exception:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
