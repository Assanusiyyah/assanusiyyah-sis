// ── AI Proxy — Netlify Function ──
// Calls Anthropic API server-side. Never exposes API key to browser.
const { requireAuth } = require("./utils/auth");

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

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  const auth = requireAuth(event, {});
  if (!auth.ok) {
    return { statusCode: auth.statusCode, headers, body: JSON.stringify({ error: auth.error }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { prompt, max_tokens, system } = body;

  if (!prompt) return { statusCode: 400, headers, body: JSON.stringify({ error: "prompt is required" }) };

  try {
    const messages = [{ role: "user", content: prompt }];

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": process.env.ANTHROPIC_API_KEY || ""
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: max_tokens || 1500,
        ...(system ? { system } : {}),
        messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("[AI Proxy] Anthropic error:", JSON.stringify(data));
      return { statusCode: 500, headers, body: JSON.stringify({ error: data.error?.message || "AI generation failed" }) };
    }

    const textBlock = (data.content || []).find(b => b.type === "text");
    if (!textBlock) return { statusCode: 500, headers, body: JSON.stringify({ error: "No text content returned" }) };

    return { statusCode: 200, headers, body: JSON.stringify({ text: textBlock.text }) };

  } catch(err) {
    console.error("[AI Proxy]", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
