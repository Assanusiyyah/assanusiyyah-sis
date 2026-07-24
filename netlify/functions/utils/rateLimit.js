// ── Login attempt rate limiting ──
// Netlify Functions have no persistent memory between invocations, so brute-
// force protection has to live in the database. Tracks failed attempts per
// identifier (admin username / admission no / application ref) in a small
// `login_attempts` table and locks that identifier out once too many wrong
// guesses land in a short window.
//
// Requires a Supabase table, same id/data/updated_at shape as every other
// table in this app:
//   create table login_attempts (
//     id text primary key,
//     data jsonb not null,
//     updated_at timestamptz not null default now()
//   );
// Until that table exists, every call below fails open (getRecord/putRecord
// swallow errors) — logins keep working exactly as before, just without the
// lockout, so this ships safely ahead of the migration being run.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // lock duration once MAX_ATTEMPTS is hit
const WINDOW_MS = 15 * 60 * 1000;  // failures older than this don't count toward the total

function sbHeaders() {
  return { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY };
}

async function getRecord(key) {
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/login_attempts?id=eq.${encodeURIComponent(key)}&select=data`, { headers: sbHeaders() });
    if (!resp.ok) return null;
    const rows = await resp.json();
    return Array.isArray(rows) && rows[0] ? rows[0].data : null;
  } catch (e) { return null; }
}

async function putRecord(key, data) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/login_attempts`, {
      method: "POST",
      headers: Object.assign({}, sbHeaders(), { "Prefer": "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({ id: key, data: data, updated_at: new Date().toISOString() })
    });
  } catch (e) { /* best-effort — never block a login on this write failing */ }
}

// Call before checking a password/PIN. { blocked: true, retryAfterSec } if locked out.
async function checkLockout(key) {
  const rec = await getRecord(key);
  if (!rec || !rec.lockedUntil) return { blocked: false };
  const now = Date.now();
  if (rec.lockedUntil > now) return { blocked: true, retryAfterSec: Math.ceil((rec.lockedUntil - now) / 1000) };
  return { blocked: false };
}

// Call after a failed attempt. Locks the identifier once MAX_ATTEMPTS lands within WINDOW_MS.
async function recordFailure(key) {
  const now = Date.now();
  const rec = (await getRecord(key)) || {};
  const withinWindow = rec.firstFailAt && (now - rec.firstFailAt) < WINDOW_MS;
  const count = (withinWindow ? (rec.count || 0) : 0) + 1;
  const next = { count: count, firstFailAt: withinWindow ? rec.firstFailAt : now };
  if (count >= MAX_ATTEMPTS) next.lockedUntil = now + LOCKOUT_MS;
  await putRecord(key, next);
}

// Call after a successful login to clear any accumulated failures.
async function recordSuccess(key) {
  await putRecord(key, { count: 0 });
}

module.exports = { checkLockout, recordFailure, recordSuccess };
