/**
 * Server-only e-mail transport. The only provider is Resend, and only when BOTH
 * RESEND_API_KEY and EMAIL_FROM are set in the server environment. With either missing the
 * app reports "not configured" and sends nothing. Secrets never leave the server.
 */

export type EmailConfig =
  | { configured: true; provider: "resend"; from: string; apiKey: string }
  | { configured: false; missing: string[] };

export function readEmailConfig(
  env: Record<string, string | undefined> = process.env,
): EmailConfig {
  const apiKey = (env["RESEND_API_KEY"] ?? "").trim();
  const from = (env["EMAIL_FROM"] ?? "").trim();
  const missing = [...(apiKey ? [] : ["RESEND_API_KEY"]), ...(from ? [] : ["EMAIL_FROM"])];
  if (missing.length) return { configured: false, missing };
  return { configured: true, provider: "resend", from, apiKey };
}

export type SendResult = { ok: true; messageId: string | null } | { ok: false; error: string };

export async function sendViaResend(
  config: Extract<EmailConfig, { configured: true }>,
  message: { to: string[]; subject: string; html: string; text: string; replyTo?: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
      name?: string;
    };
    if (!res.ok) {
      return {
        ok: false,
        error: (body.message || body.name || `Provider error (HTTP ${res.status})`).slice(0, 300),
      };
    }
    return { ok: true, messageId: body.id ?? null };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message.slice(0, 300) : "Could not reach the e-mail provider",
    };
  }
}
