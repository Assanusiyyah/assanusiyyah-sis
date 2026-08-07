// ── Shared CORS headers (Cloudflare Pages Functions) ──
// Cloudflare injects CF_PAGES_BRANCH (the branch being deployed) instead of
// Netlify's CONTEXT — comparing it to your production branch ("main") is
// the equivalent check.
export function corsHeaders(env, extra) {
  const isProd = env.CF_PAGES_BRANCH === "main";
  const origin = (isProd && env.ALLOWED_ORIGIN) ? env.ALLOWED_ORIGIN : "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": extra || "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
}

export function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: headers });
}
