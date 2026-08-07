// ── Termii SMS Proxy — Cloudflare Pages Function ──
// Ported from netlify/functions/sms.js — logic unchanged, including the
// staff-only role restriction.
import { requireAuth } from "../_utils/auth.js";
import { corsHeaders, jsonResponse } from "../_utils/cors.js";

const TERMII_URL = "https://v3.api.termii.com/api/sms/send";

function formatNGPhone(phone) {
  const p = String(phone || "").replace(/\D/g, "");
  if (p.startsWith("234")) return "+" + p;
  if (p.startsWith("0") && p.length === 11) return "+234" + p.slice(1);
  if (p.length === 10) return "+234" + p;
  return "+" + p;
}

export async function onRequestOptions({ env }) {
  return new Response("", { status: 200, headers: corsHeaders(env, "Content-Type, Authorization") });
}

export async function onRequestPost({ request, env }) {
  const headers = corsHeaders(env, "Content-Type, Authorization");
  const TERMII_KEY = env.TERMII_KEY;
  const TERMII_SENDER = env.TERMII_SENDER || "ASSANUSIYYA";

  const auth = requireAuth(env, request, {});
  if (!auth.ok) {
    return jsonResponse({ error: auth.error }, auth.status, headers);
  }
  if (auth.payload.role === "parent" || auth.payload.role === "candidate") {
    return jsonResponse({ error: "Forbidden" }, 403, headers);
  }

  if (!TERMII_KEY) {
    return jsonResponse({ error: "SMS not configured. Add TERMII_KEY in Cloudflare Pages environment variables." }, 500, headers);
  }

  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResponse({ error: "Invalid JSON" }, 400, headers); }

  const { to, message, label } = body;

  if (!to || !message) {
    return jsonResponse({ error: "to and message are required" }, 400, headers);
  }

  if (message.length > 918) {
    return jsonResponse({ error: "Message too long" }, 400, headers);
  }

  const formatted = formatNGPhone(to);

  if (!formatted.startsWith("+234") || formatted.length < 14) {
    return jsonResponse({ error: "Invalid Nigerian number: " + formatted }, 400, headers);
  }

  console.log(`[SMS] ${label || "SMS"} → ${formatted}`);

  try {
    const res = await fetch(TERMII_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: formatted,
        from: TERMII_SENDER,
        sms: message,
        type: "plain",
        channel: "generic",
        api_key: TERMII_KEY
      })
    });

    const data = await res.json();

    if (data.code === "ok" || data.message_id) {
      return jsonResponse({ success: true, id: data.message_id }, 200, headers);
    }

    console.warn("[SMS] Termii error:", JSON.stringify(data));
    return jsonResponse({ success: false, error: data.message || "Delivery failed" }, 400, headers);

  } catch (err) {
    console.error("[SMS Proxy]", err.message);
    return jsonResponse({ success: false, error: err.message }, 500, headers);
  }
}
