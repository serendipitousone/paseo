import { describe, expect, test } from "vitest";

import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages.js";

describe("Paseo Agent config RPC schemas", () => {
  test("parses provider config requests with providerType outside the message type field", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "config.paseo_agent.set_provider.request",
      requestId: "req-set-openrouter",
      name: "openrouter-main",
      providerType: "openrouter",
      options: {
        apiKey: "sk-test",
        models: [{ id: "anthropic/claude-3.7-sonnet", reasoning: true }],
      },
    });

    expect(parsed.type).toBe("config.paseo_agent.set_provider.request");
    expect(parsed.providerType).toBe("openrouter");
  });

  test("parses redacted provider responses without raw secret fields", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "config.paseo_agent.get_providers.response",
      payload: {
        requestId: "req-get",
        defaultModel: "openrouter-main/anthropic/claude-3.7-sonnet",
        providers: [
          {
            name: "openrouter-main",
            providerType: "openrouter",
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-completions",
            models: [{ id: "anthropic/claude-3.7-sonnet" }],
            auth: { kind: "api_key", configured: true, source: "literal" },
            available: true,
            error: null,
          },
        ],
        error: null,
      },
    });

    expect(parsed.payload.providers[0]?.providerType).toBe("openrouter");
    expect(JSON.stringify(parsed)).not.toContain("apiKey");
  });

  test("preserves future OAuth credential fields on inbound schema parse", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "config.paseo_agent.store_chatgpt_credential.request",
      requestId: "req-oauth",
      providerName: "chatgpt",
      credential: {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: 123,
        accountId: "acct_123",
        futureField: { keep: true },
      },
    });

    expect(parsed.credential.futureField).toEqual({ keep: true });
  });

  test("parses ChatGPT provider config separately from credential storage", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "config.paseo_agent.set_provider.request",
      requestId: "req-set-chatgpt",
      name: "chatgpt",
      providerType: "openai-codex",
      options: {
        models: [{ id: "gpt-5.3-codex", reasoning: true }],
      },
    });

    expect(parsed.providerType).toBe("openai-codex");
    expect(JSON.stringify(parsed)).not.toContain("access-token");
  });
});
