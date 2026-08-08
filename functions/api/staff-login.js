// ── Staff Login — Cloudflare Pages Function ──
// Lets a registered staff member (the `staff` table, managed in the Staff
// module) log in without a separate admins_list account. Username is the
// `username` field stored on their staff record (surname, collision-suffixed
// with their id if another staff member shares the surname — see StaffModule);
// password is simply their staff record's own `id`. There is no separate
// credential to manage — the record IS the login.
import { signToken } from "../_utils/auth.js";
import { checkLockout, recordFailure, recordSuccess } from "../_utils/rateLimit.js";
import { corsHeaders, jsonResponse } from "../_utils/cors.js";

// Fixed permission set for every staff-role login — dashboard, eLibrary,
// read-only gallery, and their own subject/class-scoped results/lessons/exams,
// plus the school diary and calendar. Never "all" — staff tokens are also
// walled off from /api/db entirely (see functions/api/db.js), so this list
// only controls sidebar/routing, not a real security boundary by itself.
const STAFF_PERMISSIONS = ["dashboard", "elibrary", "gallery", "results", "lessons", "exams", "diary", "calendar"];

// Mirrors computeStaffUsername() in src/App.jsx (StaffModule). Staff created
// before that field existed have no stored `username` on their record — this
// derives what it WOULD be so those legacy records can still log in, instead
// of requiring an admin to open and re-save every existing staff member first.
function computeUsername(surname, id, allStaff, excludeId) {
  const base = String(surname || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const collides = (allStaff || []).some(function(s) {
    return s.id !== excludeId && (s.username ? s.username === base : computeUsernameBase(s.surname) === base);
  });
  return collides ? (base + "-" + String(id).toLowerCase()) : base;
}
function computeUsernameBase(surname) {
  return String(surname || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
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

  const { username, password } = body;
  if (!username || !password) {
    return jsonResponse({ success: false, error: "Username and password required" }, 400, headers);
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return jsonResponse({ success: false, error: "Database not configured." }, 500, headers);
  }

  const wantedUsername = String(username).trim().toLowerCase();
  const lockKey = "staff:" + wantedUsername;
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
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/staff?select=id,data&limit=2000`, { headers: sbHeaders });
    if (!resp.ok) {
      const err = await resp.text();
      console.error("[StaffLogin] Supabase fetch failed:", resp.status, err);
      return jsonResponse({ success: false, error: "DB error: " + resp.status }, 200, headers);
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
      await recordFailure(env, lockKey);
      console.log("[StaffLogin] FAILED for:", username);
      return jsonResponse({ success: false, error: "Invalid username or password" }, 200, headers);
    }

    const staff = match.data;
    if (staff.active === false) {
      return jsonResponse({ success: false, error: "Account deactivated" }, 200, headers);
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

    await recordSuccess(env, lockKey);
    const token = signToken(env, {
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
    return jsonResponse({ success: true, token: token, admin: admin }, 200, headers);

  } catch (err) {
    console.error("[StaffLogin] Exception:", err.message);
    return jsonResponse({ error: err.message }, 500, headers);
  }
}
