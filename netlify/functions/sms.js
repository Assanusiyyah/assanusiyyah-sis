// ── Termii SMS Proxy — Netlify Function ──
// Runs on Netlify's server. Termii key never reaches the browser.
const { requireAuth } = require("./utils/auth");

const TERMII_KEY    = process.env.TERMII_KEY;
const TERMII_SENDER = process.env.TERMII_SENDER || "ASSANUSIYYA";
const TERMII_URL    = "https://v3.api.termii.com/api/sms/send";

function formatNGPhone(phone) {
  const p = String(phone || "").replace(/\D/g, "");
  if (p.startsWith("234")) return "+" + p;
  if (p.startsWith("0") && p.length === 11) return "+234" + p.slice(1);
  if (p.length === 10) return "+234" + p;
  return "+" + p;
}

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

exports.handler = async function(event, context) {
  const headers = corsHeaders();

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const auth = requireAuth(event, {});
  if (!auth.ok) {
    return { statusCode: auth.statusCode, headers, body: JSON.stringify({ error: auth.error }) };
  }

  if (!TERMII_KEY) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: "SMS not configured. Add TERMII_KEY in Netlify Environment Variables." })
    };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { to, message, label } = body;

  if (!to || !message) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "to and message are required" }) };
  }

  if (message.length > 918) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Message too long" }) };
  }

  const formatted = formatNGPhone(to);

  if (!formatted.startsWith("+234") || formatted.length < 14) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid Nigerian number: " + formatted }) };
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
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, id: data.message_id }) };
    }

    console.warn("[SMS] Termii error:", JSON.stringify(data));
    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: data.message || "Delivery failed" }) };

  } catch(err) {
    console.error("[SMS Proxy]", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
