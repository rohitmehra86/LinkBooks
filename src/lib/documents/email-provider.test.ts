import { describe, expect, it, vi } from "vitest";
import { readEmailConfig, sendViaResend } from "@/lib/documents/email-provider.server";

describe("email provider config", () => {
  it("is not configured without an API key and a from address", () => {
    expect(readEmailConfig({})).toEqual({
      configured: false,
      missing: ["RESEND_API_KEY", "EMAIL_FROM"],
    });
    expect(readEmailConfig({ RESEND_API_KEY: "k" })).toEqual({
      configured: false,
      missing: ["EMAIL_FROM"],
    });
    expect(readEmailConfig({ RESEND_API_KEY: "  ", EMAIL_FROM: "a@b.co" })).toEqual({
      configured: false,
      missing: ["RESEND_API_KEY"],
    });
  });

  it("is configured with both values", () => {
    expect(
      readEmailConfig({ RESEND_API_KEY: "k", EMAIL_FROM: "LinkBooks <a@b.co>" }),
    ).toMatchObject({
      configured: true,
      provider: "resend",
      from: "LinkBooks <a@b.co>",
    });
  });
});

describe("resend transport", () => {
  const cfg = {
    configured: true as const,
    provider: "resend" as const,
    from: "a@b.co",
    apiKey: "secret",
  };
  const msg = { to: ["x@y.co"], subject: "S", html: "<p>h</p>", text: "h", replyTo: "r@y.co" };

  it("posts the message with a bearer key and returns the provider id", async () => {
    const fetchMock = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }),
    );
    const res = await sendViaResend(cfg, msg, fetchMock as unknown as typeof fetch);
    expect(res).toEqual({ ok: true, messageId: "msg_1" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect((init!.headers as Record<string, string>)["Authorization"]).toBe("Bearer secret");
    expect(JSON.parse(String(init!.body))).toMatchObject({
      from: "a@b.co",
      to: ["x@y.co"],
      reply_to: "r@y.co",
    });
  });

  it("surfaces a provider rejection without throwing", async () => {
    const f = async () =>
      new Response(JSON.stringify({ message: "Domain not verified" }), { status: 403 });
    expect(await sendViaResend(cfg, msg, f as unknown as typeof fetch)).toEqual({
      ok: false,
      error: "Domain not verified",
    });
  });

  it("reports a network failure", async () => {
    const f = async () => {
      throw new Error("offline");
    };
    expect(await sendViaResend(cfg, msg, f as unknown as typeof fetch)).toEqual({
      ok: false,
      error: "offline",
    });
  });
});
