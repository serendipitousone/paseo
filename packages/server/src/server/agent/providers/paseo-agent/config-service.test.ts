import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { loadPersistedConfig, savePersistedConfig } from "../../../persisted-config.js";
import { PaseoAgentConfigService } from "./config-service.js";
import { paseoAgentAuthStoragePath } from "./oauth-store.js";

describe("PaseoAgentConfigService", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "paseo-agent-config-service-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("persists an OpenRouter provider and returns only redacted auth state", () => {
    const onConfigChanged = vi.fn();
    const service = new PaseoAgentConfigService({
      paseoHome: home,
      logger: createTestLogger(),
      onConfigChanged,
    });

    const provider = service.setProvider({
      name: "openrouter-main",
      providerType: "openrouter",
      options: {
        apiKey: "sk-secret-openrouter",
        headers: { Authorization: "Bearer header-secret" },
        models: [{ id: "anthropic/claude-3.7-sonnet", reasoning: true }],
      },
    });

    const persisted = loadPersistedConfig(home);
    expect(persisted.agents?.paseo?.providers?.["openrouter-main"]).toMatchObject({
      type: "openrouter",
      options: { apiKey: "sk-secret-openrouter" },
    });
    expect(provider).toMatchObject({
      name: "openrouter-main",
      providerType: "openrouter",
      auth: { kind: "api_key", configured: true, source: "literal" },
      available: true,
    });
    expect(JSON.stringify(service.getProviders())).not.toContain("sk-secret-openrouter");
    expect(JSON.stringify(service.getProviders())).not.toContain("header-secret");
    expect(onConfigChanged).toHaveBeenCalledWith(
      expect.objectContaining({ providers: expect.any(Object) }),
    );
  });

  test("preserves shared config fields when writing agents.paseo", () => {
    const logger = createTestLogger();
    savePersistedConfig(
      home,
      {
        daemon: { appendSystemPrompt: "Keep existing daemon settings." },
        app: { baseUrl: "http://localhost:8081" },
        agents: {
          providers: {
            gemini: {
              extends: "acp",
              label: "Gemini",
              command: ["gemini", "--acp"],
            },
          },
        },
      },
      logger,
    );
    const service = new PaseoAgentConfigService({
      paseoHome: home,
      logger,
    });

    service.setProvider({
      name: "openrouter-main",
      providerType: "openrouter",
      options: {
        apiKey: "sk-secret-openrouter",
        models: [{ id: "anthropic/claude-3.7-sonnet" }],
      },
    });

    const persisted = loadPersistedConfig(home);
    expect(persisted.daemon?.appendSystemPrompt).toBe("Keep existing daemon settings.");
    expect(persisted.app?.baseUrl).toBe("http://localhost:8081");
    expect(persisted.agents?.providers?.gemini).toMatchObject({
      extends: "acp",
      label: "Gemini",
    });
    expect(persisted.agents?.paseo?.providers?.["openrouter-main"]?.options.apiKey).toBe(
      "sk-secret-openrouter",
    );
  });

  test("stores ChatGPT OAuth credentials in the Paseo-owned auth store with future fields intact", () => {
    const service = new PaseoAgentConfigService({
      paseoHome: home,
      logger: createTestLogger(),
    });

    service.storeChatGptCredential("chatgpt", {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: 123,
      accountId: "acct_123",
      futureField: { keep: true },
    });

    const authPath = paseoAgentAuthStoragePath({ PASEO_HOME: home });
    const stored = JSON.parse(readFileSync(authPath, "utf8"));
    expect(stored.chatgpt).toMatchObject({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      futureField: { keep: true },
    });
    expect(authPath).toBe(join(home, "paseo-agent", "auth.json"));
  });

  test("reports ChatGPT auth as stored without returning tokens", () => {
    const service = new PaseoAgentConfigService({
      paseoHome: home,
      logger: createTestLogger(),
    });
    service.setProvider({
      name: "chatgpt",
      providerType: "openai-codex",
      options: {
        models: [{ id: "gpt-5.3-codex", reasoning: true }],
      },
    });
    service.storeChatGptCredential("chatgpt", {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: 123,
    });

    const providers = service.getProviders();
    expect(providers.providers).toEqual([
      expect.objectContaining({
        name: "chatgpt",
        providerType: "openai-codex",
        auth: { kind: "oauth", configured: true, source: "stored" },
        available: true,
      }),
    ]);
    expect(JSON.stringify(providers)).not.toContain("access-token");
    expect(JSON.stringify(providers)).not.toContain("refresh-token");
  });

  test("removes providers and clears a default model owned by that provider", () => {
    const service = new PaseoAgentConfigService({
      paseoHome: home,
      logger: createTestLogger(),
    });
    service.setProvider({
      name: "openrouter-main",
      providerType: "openrouter",
      options: {
        apiKey: "sk-secret-openrouter",
        models: [{ id: "anthropic/claude-3.7-sonnet" }],
      },
    });
    service.setDefaultModel("openrouter-main/anthropic/claude-3.7-sonnet");

    expect(service.removeProvider("openrouter-main")).toBe(true);
    expect(service.getProviders()).toEqual({ defaultModel: null, providers: [] });
  });
});
