/**
 * Server-only AI provider configuration.
 * Never import secret values into client components. Never use VITE_ for AI keys.
 */

export type AiProviderConfig = {
  configured: boolean;
  provider: "openai_compatible" | "none";
  model: string;
  baseUrl: string;
  /** Present only in server memory — never serialize to the client. */
  apiKey: string | null;
  maxRequestsPerHour: number;
  maxContextChars: number;
  maxOutputTokens: number;
};

export type AiPublicStatus = {
  configured: boolean;
  provider: "openai_compatible" | "none";
  model: string | null;
  maxRequestsPerHour: number;
  message: string;
};

function readEnv(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Full server config including apiKey — do not return from server fns to the browser. */
export function getAiServerConfig(): AiProviderConfig {
  const apiKey = readEnv("AI_API_KEY") ?? readEnv("OPENAI_API_KEY") ?? null;
  const baseUrl = (readEnv("AI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = readEnv("AI_MODEL") ?? "gpt-4o-mini";
  const maxRequestsPerHour = Math.min(
    200,
    Math.max(1, Number(readEnv("AI_MAX_REQUESTS_PER_HOUR") ?? "30") || 30),
  );
  const maxContextChars = Math.min(
    40_000,
    Math.max(2_000, Number(readEnv("AI_MAX_CONTEXT_CHARS") ?? "12000") || 12_000),
  );
  const maxOutputTokens = Math.min(
    4_000,
    Math.max(256, Number(readEnv("AI_MAX_OUTPUT_TOKENS") ?? "1200") || 1_200),
  );

  if (!apiKey) {
    return {
      configured: false,
      provider: "none",
      model,
      baseUrl,
      apiKey: null,
      maxRequestsPerHour,
      maxContextChars,
      maxOutputTokens,
    };
  }

  return {
    configured: true,
    provider: "openai_compatible",
    model,
    baseUrl,
    apiKey,
    maxRequestsPerHour,
    maxContextChars,
    maxOutputTokens,
  };
}

/** Safe status for UI — no secrets. */
export function getAiPublicStatus(): AiPublicStatus {
  const cfg = getAiServerConfig();
  if (!cfg.configured) {
    return {
      configured: false,
      provider: "none",
      model: null,
      maxRequestsPerHour: cfg.maxRequestsPerHour,
      message:
        "AI is not configured. Set server-only AI_API_KEY (and optional AI_MODEL / AI_BASE_URL). No simulated answers are returned.",
    };
  }
  return {
    configured: true,
    provider: cfg.provider,
    model: cfg.model,
    maxRequestsPerHour: cfg.maxRequestsPerHour,
    message: "AI provider configured on the server. Suggestions never post without confirmation.",
  };
}

/** Reject accidental Vite exposure of AI keys. */
export function findUnsafeAiViteKeys(
  env: Record<string, string | undefined> = {},
): string[] {
  const bad: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("VITE_")) continue;
    const upper = key.toUpperCase();
    if (
      upper.includes("AI_API") ||
      upper.includes("OPENAI") ||
      upper.includes("ANTHROPIC") ||
      (typeof value === "string" &&
        (value.startsWith("sk-") || value.includes("openai")))
    ) {
      bad.push(key);
    }
  }
  return bad;
}
