// ── AI Proxy — Cloudflare Pages Function ──
// Ported from netlify/functions/ai.js — logic unchanged, including the
// staff-only role restriction.
import { requireAuth } from "../_utils/auth.js";
import { corsHeaders, jsonResponse } from "../_utils/cors.js";

export async function onRequestOptions({ env }) {
  return new Response("", { status: 200, headers: corsHeaders(env, "Content-Type, Authorization") });
}

export async function onRequestPost({ request, env }) {
  const headers = corsHeaders(env, "Content-Type, Authorization");

  const auth = requireAuth(env, request, {});
  if (!auth.ok) {
    return jsonResponse({ error: auth.error }, auth.status, headers);
  }
  if (auth.payload.role === "parent" || auth.payload.role === "candidate") {
    return jsonResponse({ error: "Forbidden" }, 403, headers);
  }

  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResponse({ error: "Invalid JSON" }, 400, headers); }

  const { prompt, max_tokens, system } = body;
  if (!prompt) return jsonResponse({ error: "prompt is required" }, 400, headers);

  try {
    const messages = [{ role: "user", content: prompt }];

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": env.ANTHROPIC_API_KEY || ""
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: max_tokens || 1500,
        ...(system ? { system } : {}),
        messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("[AI Proxy] Anthropic error:", JSON.stringify(data));
      return jsonResponse({ error: data.error?.message || "AI generation failed" }, 500, headers);
    }

    const textBlock = (data.content || []).find(b => b.type === "text");
    if (!textBlock) return jsonResponse({ error: "No text content returned" }, 500, headers);

    return jsonResponse({ text: textBlock.text }, 200, headers);

  } catch (err) {
    console.error("[AI Proxy]", err.message);
    return jsonResponse({ error: err.message }, 500, headers);
  }
}
