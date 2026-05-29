import { describe, expect, it } from "vitest";

import {
  PaseoAgentConfigSchema,
  encodePaseoAgentModelId,
  listPaseoAgentModels,
  paseoAgentHasUsableModel,
  paseoAgentInferenceProviders,
  parsePaseoAgentModelId,
  resolvePaseoAgentModel,
  type PaseoAgentConfig,
} from "./config.js";

function configWith(overrides?: Partial<PaseoAgentConfig>): PaseoAgentConfig {
  return PaseoAgentConfigSchema.parse({
    providers: {
      "openrouter-main": {
        type: "openrouter",
        options: {
          apiKey: "sk-test",
          models: [
            { id: "anthropic/claude", label: "Claude", reasoning: true },
            { id: "openai/gpt", reasoning: false },
          ],
        },
      },
    },
    ...overrides,
  });
}

describe("PaseoAgentConfigSchema", () => {
  it("rejects unknown keys (strict)", () => {
    expect(() => PaseoAgentConfigSchema.parse({ providers: {}, unexpected: true })).toThrow();
  });

  it("rejects an unknown inference provider type", () => {
    expect(() =>
      PaseoAgentConfigSchema.parse({
        providers: { p: { type: "mystery", options: { models: [{ id: "m" }] } } },
      }),
    ).toThrow();
  });

  it("requires at least one model per inference provider", () => {
    expect(() =>
      PaseoAgentConfigSchema.parse({
        providers: { p: { type: "openrouter", options: { models: [] } } },
      }),
    ).toThrow();
  });

  it("requires baseUrl for openai-compatible and api for custom", () => {
    expect(() =>
      PaseoAgentConfigSchema.parse({
        providers: { p: { type: "openai-compatible", options: { models: [{ id: "m" }] } } },
      }),
    ).toThrow(/baseUrl/);
    expect(() =>
      PaseoAgentConfigSchema.parse({
        providers: {
          p: { type: "custom", options: { baseUrl: "https://x.test", models: [{ id: "m" }] } },
        },
      }),
    ).toThrow(/api/);
  });

  it("accepts an empty config", () => {
    expect(PaseoAgentConfigSchema.parse({})).toEqual({});
  });

  it("accepts multiple entries of the same type with distinct names", () => {
    const config = PaseoAgentConfigSchema.parse({
      providers: {
        "openai-a": { type: "openai", options: { apiKey: "sk-a", models: [{ id: "gpt-a" }] } },
        "openai-b": {
          type: "openai",
          options: { baseUrl: "https://proxy.test/v1", apiKey: "sk-b", models: [{ id: "gpt-b" }] },
        },
      },
    });
    expect(Object.keys(config.providers ?? {})).toEqual(["openai-a", "openai-b"]);
  });
});

describe("model id encoding", () => {
  it("round-trips provider + model id", () => {
    const id = encodePaseoAgentModelId("openrouter-main", "anthropic/claude");
    expect(parsePaseoAgentModelId(id)).toEqual({
      provider: "openrouter-main",
      id: "anthropic/claude",
    });
  });

  it("returns null for an unprefixed id", () => {
    expect(parsePaseoAgentModelId("noslash")).toBeNull();
  });
});

describe("listPaseoAgentModels", () => {
  it("exposes every configured model with provider-prefixed ids", () => {
    const models = listPaseoAgentModels(configWith());
    expect(models.map((m) => m.id)).toEqual([
      "openrouter-main/anthropic/claude",
      "openrouter-main/openai/gpt",
    ]);
    expect(models.every((m) => m.provider === "paseo")).toBe(true);
  });

  it("marks the configured default model", () => {
    const models = listPaseoAgentModels(configWith({ defaultModel: "openrouter-main/openai/gpt" }));
    const defaults = models.filter((m) => m.isDefault).map((m) => m.id);
    expect(defaults).toEqual(["openrouter-main/openai/gpt"]);
  });
});

describe("paseoAgentInferenceProviders (per-type defaults)", () => {
  it("applies openrouter defaults (base url, api, model fields)", () => {
    const [provider] = paseoAgentInferenceProviders(configWith());
    expect(provider.name).toBe("openrouter-main");
    expect(provider.config.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(provider.config.apiKey).toBe("sk-test");
    expect(provider.config.models?.[0]).toMatchObject({
      id: "anthropic/claude",
      name: "Claude",
      api: "openai-completions",
      reasoning: true,
      contextWindow: 128_000,
      maxTokens: 16_384,
    });
  });

  it("falls back to the type's env var when no apiKey is given", () => {
    const config = PaseoAgentConfigSchema.parse({
      providers: {
        anthropic: { type: "anthropic", options: { models: [{ id: "claude-x" }] } },
      },
    });
    const [provider] = paseoAgentInferenceProviders(config);
    expect(provider.config.baseUrl).toBe("https://api.anthropic.com");
    expect(provider.config.apiKey).toBe("$ANTHROPIC_API_KEY");
    expect(provider.config.models?.[0]?.api).toBe("anthropic-messages");
  });

  it("supports an OpenCode Zen / openai-compatible endpoint with per-model api override", () => {
    const config = PaseoAgentConfigSchema.parse({
      providers: {
        zen: {
          type: "openai-compatible",
          options: {
            baseUrl: "https://opencode.ai/zen/v1",
            apiKey: "$OPENCODE_API_KEY",
            models: [{ id: "big-pickle" }, { id: "claude-sonnet", api: "anthropic-messages" }],
          },
        },
      },
    });
    const [provider] = paseoAgentInferenceProviders(config);
    expect(provider.config.baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(provider.config.models?.[0]?.api).toBe("openai-completions");
    expect(provider.config.models?.[1]?.api).toBe("anthropic-messages");
  });

  it("passes through the custom escape hatch (explicit api + authHeader)", () => {
    const config = PaseoAgentConfigSchema.parse({
      providers: {
        vertex: {
          type: "custom",
          options: {
            baseUrl: "https://my-gateway.test/v1",
            api: "google-generative-ai",
            apiKey: "sk-custom",
            authHeader: true,
            headers: { "x-extra": "1" },
            models: [{ id: "gemini" }],
          },
        },
      },
    });
    const [provider] = paseoAgentInferenceProviders(config);
    expect(provider.config.api).toBe("google-generative-ai");
    expect(provider.config.authHeader).toBe(true);
    expect(provider.config.headers).toEqual({ "x-extra": "1" });
    expect(provider.config.models?.[0]?.api).toBe("google-generative-ai");
  });
});

describe("paseoAgentHasUsableModel (env-aware auth)", () => {
  it("is true for a literal api key", () => {
    expect(paseoAgentHasUsableModel(configWith(), {})).toBe(true);
  });

  it("is false when no providers are configured", () => {
    expect(paseoAgentHasUsableModel(PaseoAgentConfigSchema.parse({}), {})).toBe(false);
  });

  it("is false for an openai-compatible provider without any key", () => {
    const config = PaseoAgentConfigSchema.parse({
      providers: {
        local: {
          type: "openai-compatible",
          options: { baseUrl: "https://local.test/v1", models: [{ id: "m" }] },
        },
      },
    });
    expect(paseoAgentHasUsableModel(config, {})).toBe(false);
  });

  it("follows the env var for an env-backed key", () => {
    const config = PaseoAgentConfigSchema.parse({
      providers: { openrouter: { type: "openrouter", options: { models: [{ id: "m" }] } } },
    });
    expect(paseoAgentHasUsableModel(config, {})).toBe(false);
    expect(paseoAgentHasUsableModel(config, { OPENROUTER_API_KEY: "sk-env" })).toBe(true);
  });
});

describe("resolvePaseoAgentModel", () => {
  it("prefers the explicit request, then default, then first configured", () => {
    const config = configWith({ defaultModel: "openrouter-main/openai/gpt" });
    expect(resolvePaseoAgentModel(config, "openrouter-main/anthropic/claude")).toEqual({
      provider: "openrouter-main",
      id: "anthropic/claude",
    });
    expect(resolvePaseoAgentModel(config, null)).toEqual({
      provider: "openrouter-main",
      id: "openai/gpt",
    });
    expect(resolvePaseoAgentModel(configWith(), null)).toEqual({
      provider: "openrouter-main",
      id: "anthropic/claude",
    });
  });

  it("returns undefined when no providers are configured", () => {
    expect(resolvePaseoAgentModel(PaseoAgentConfigSchema.parse({}), null)).toBeUndefined();
  });

  it("ignores an implicit default whose provider is not registered", () => {
    const config = configWith({ defaultModel: "ghost/model" });
    expect(resolvePaseoAgentModel(config, null)).toEqual({
      provider: "openrouter-main",
      id: "anthropic/claude",
    });
  });

  it("honors an explicit request even if its provider is not registered", () => {
    expect(resolvePaseoAgentModel(configWith(), "ghost/model")).toEqual({
      provider: "ghost",
      id: "model",
    });
  });
});

describe("openai-codex (ChatGPT subscription) provider", () => {
  function codexConfig(options: Record<string, unknown>): PaseoAgentConfig {
    return PaseoAgentConfigSchema.parse({
      providers: {
        chatgpt: {
          type: "openai-codex",
          options: { models: [{ id: "gpt-5.3-codex" }], ...options },
        },
      },
    });
  }

  it("accepts a codex provider with no credential field (login provides it)", () => {
    const config = codexConfig({});
    expect(config.providers?.chatgpt?.type).toBe("openai-codex");
  });

  it("rejects an unknown option like a foreign credentials file", () => {
    expect(() =>
      PaseoAgentConfigSchema.parse({
        providers: {
          chatgpt: {
            type: "openai-codex",
            options: { credentialsFile: "/Users/me/.codex/auth.json", models: [{ id: "x" }] },
          },
        },
      }),
    ).toThrow();
  });

  it("maps to a codex inference provider with an oauth marker and no api key", () => {
    const [provider] = paseoAgentInferenceProviders(codexConfig({}), {});
    expect(provider.name).toBe("chatgpt");
    expect(provider.oauth).toEqual({ kind: "openai-codex" });
    expect(provider.config.apiKey).toBeUndefined();
    expect(provider.config.api).toBe("openai-codex-responses");
    expect(provider.config.baseUrl).toBe("https://chatgpt.com/backend-api");
    expect(provider.config.models?.[0]?.api).toBe("openai-codex-responses");
  });

  it("carries an advanced self-supplied refresh token resolved from an env var", () => {
    const config = codexConfig({ refreshToken: "$CODEX_REFRESH_TOKEN" });
    const [provider] = paseoAgentInferenceProviders(config, { CODEX_REFRESH_TOKEN: "rt-env" });
    expect(provider.oauth).toEqual({ kind: "openai-codex", refreshToken: "rt-env" });
  });

  it("availability uses the OAuth store predicate, or an advanced refresh token", () => {
    // No stored credential and no advanced token → not available.
    expect(paseoAgentHasUsableModel(codexConfig({}), {})).toBe(false);
    // Stored credential (predicate true) → available.
    expect(paseoAgentHasUsableModel(codexConfig({}), {}, () => true)).toBe(true);
    // Advanced env-backed token → available without the store.
    expect(
      paseoAgentHasUsableModel(codexConfig({ refreshToken: "$CODEX_REFRESH_TOKEN" }), {
        CODEX_REFRESH_TOKEN: "rt-env",
      }),
    ).toBe(true);
  });

  it("lists codex models regardless of auth state", () => {
    const models = listPaseoAgentModels(codexConfig({}));
    expect(models.map((m) => m.id)).toEqual(["chatgpt/gpt-5.3-codex"]);
  });
});
