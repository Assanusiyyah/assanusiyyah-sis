// ── Login attempt rate limiting (Cloudflare Pages Functions) ──
// Ported from netlify/functions/utils/rateLimit.js — identical logic and the
// same `login_attempts` Supabase table, just takes `env` as an explicit
// parameter instead of reading process.env (Workers doesn't populate that
// the way Node does).
//
// Fails open if the table doesn't exist yet or a call errors — see the
// Netlify version's migration note; same `login_attempts` table serves both.

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;

function sbHeaders(env) {
  return { "Content-Type": "application/json", "apikey": env.SUPABASE_KEY, "Authorization": "Bearer " + env.SUPABASE_KEY };
}

async function getRecord(env, key) {
  try {
    const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/login_attempts?id=eq.${encodeURIComponent(key)}&select=data`, { headers: sbHeaders(env) });
    if (!resp.ok) return null;
    const rows = await resp.json();
    return Array.isArray(rows) && rows[0] ? rows[0].data : null;
  } catch (e) { return null; }
}

async function putRecord(env, key, data) {
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/login_attempts`, {
      method: "POST",
      headers: Object.assign({}, sbHeaders(env), { "Prefer": "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({ id: key, data: data, updated_at: new Date().toISOString() })
    });
  } catch (e) { /* best-effort — never block a login on this write failing */ }
}

export async function checkLockout(env, key) {
  const rec = await getRecord(env, key);
  if (!rec || !rec.lockedUntil) return { blocked: false };
  const now = Date.now();
  if (rec.lockedUntil > now) return { blocked: true, retryAfterSec: Math.ceil((rec.lockedUntil - now) / 1000) };
  return { blocked: false };
}

export async function recordFailure(env, key) {
  const now = Date.now();
  const rec = (await getRecord(env, key)) || {};
  const withinWindow = rec.firstFailAt && (now - rec.firstFailAt) < WINDOW_MS;
  const count = (withinWindow ? (rec.count || 0) : 0) + 1;
  const next = { count: count, firstFailAt: withinWindow ? rec.firstFailAt : now };
  if (count >= MAX_ATTEMPTS) next.lockedUntil = now + LOCKOUT_MS;
  await putRecord(env, key, next);
}

export async function recordSuccess(env, key) {
  await putRecord(env, key, { count: 0 });
}
