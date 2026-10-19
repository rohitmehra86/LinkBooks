import type { AiProviderConfig } from "@/lib/ai/config";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ProviderResult =
  | { ok: true; content: string; latencyMs: number; estimatedTokens: number }
  | { ok: false; errorCode: string; message: string; latencyMs: number };

/**
 * OpenAI-compatible chat completions. Failures are explicit — never invent ledger facts.
 */
export async function callChatCompletion(
  cfg: AiProviderConfig,
  messages: ChatMessage[],
  opts: { signal?: AbortSignal } = {},
): Promise<ProviderResult> {
  if (!cfg.configured || !cfg.apiKey) {
    return {
      ok: false,
      errorCode: "not_configured",
      message: "AI provider is not configured",
      latencyMs: 0,
    };
  }

  const started = Date.now();
  try {
    const init: RequestInit = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        max_tokens: cfg.maxOutputTokens,
        messages,
      }),
    };
    if (opts.signal) init.signal = opts.signal;
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, init);

    const latencyMs = Date.now() - started;
    if (!res.ok) {
      // Do not echo provider body (may contain request fragments)
      const code =
        res.status === 401 || res.status === 403
          ? "auth_failed"
          : res.status === 429
            ? "provider_rate_limit"
            : "provider_error";
      return {
        ok: false,
        errorCode: code,
        message: `AI provider request failed (${res.status})`,
        latencyMs,
      };
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: { total_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return {
        ok: false,
        errorCode: "malformed_response",
        message: "AI provider returned an empty or malformed response",
        latencyMs,
      };
    }
    return {
      ok: true,
      content: content.slice(0, 20_000),
      latencyMs,
      estimatedTokens: Number(json.usage?.total_tokens) || Math.ceil(content.length / 4),
    };
  } catch (e) {
    const latencyMs = Date.now() - started;
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      ok: false,
      errorCode: aborted ? "timeout" : "network_error",
      message: aborted ? "AI provider request timed out" : "Could not reach AI provider",
      latencyMs,
    };
  }
}
