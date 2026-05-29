import { describe, expect, it } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentSessionConfig } from "../../agent-sdk-types.js";
import { PaseoAgentClient } from "./agent.js";
import { PaseoAgentConfigSchema, type PaseoAgentConfig } from "./config.js";

function makeConfig(): PaseoAgentConfig {
  return PaseoAgentConfigSchema.parse({
    defaultModel: "openrouter-main/test-model",
    providers: {
      "openrouter-main": {
        type: "openrouter",
        options: {
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "sk-test",
          api: "openai-completions",
          models: [{ id: "test-model", label: "Test Model" }],
        },
      },
    },
  });
}

function sessionConfig(overrides?: Partial<AgentSessionConfig>): AgentSessionConfig {
  return { provider: "paseo", cwd: process.cwd(), ...overrides };
}

describe("PaseoAgentClient", () => {
  it("is available only when config has a usable inference provider", async () => {
    const withConfig = new PaseoAgentClient({ logger: createTestLogger(), config: makeConfig() });
    expect(await withConfig.isAvailable()).toBe(true);

    const empty = new PaseoAgentClient({
      logger: createTestLogger(),
      config: PaseoAgentConfigSchema.parse({}),
    });
    expect(await empty.isAvailable()).toBe(false);
  });

  it("lists only configured models, never Pi disk/default models", async () => {
    const client = new PaseoAgentClient({ logger: createTestLogger(), config: makeConfig() });
    const models = await client.listModels({ cwd: process.cwd(), force: false });
    expect(models.map((m) => m.id)).toEqual(["openrouter-main/test-model"]);
    expect(models[0]?.isDefault).toBe(true);
  });

  it("throws when creating a session with no configured providers", async () => {
    const client = new PaseoAgentClient({
      logger: createTestLogger(),
      config: PaseoAgentConfigSchema.parse({}),
    });
    await expect(client.createSession(sessionConfig())).rejects.toThrow(/no configured/i);
  });

  it("creates an in-process session bound to the configured model", async () => {
    const client = new PaseoAgentClient({ logger: createTestLogger(), config: makeConfig() });
    const session = await client.createSession(sessionConfig());
    try {
      expect(session.provider).toBe("paseo");
      const info = await session.getRuntimeInfo();
      expect(info.model).toBe("openrouter-main/test-model");
      // In-memory prototype: no durable persistence handle.
      expect(session.describePersistence()).toBeNull();
    } finally {
      await session.close();
    }
  });

  it("honors an explicitly requested model over the default", async () => {
    const config = PaseoAgentConfigSchema.parse({
      defaultModel: "openrouter-main/a",
      providers: {
        "openrouter-main": {
          type: "openrouter",
          options: {
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: "sk-test",
            api: "openai-completions",
            models: [{ id: "a" }, { id: "b" }],
          },
        },
      },
    });
    const client = new PaseoAgentClient({ logger: createTestLogger(), config });
    const session = await client.createSession(sessionConfig({ model: "openrouter-main/b" }));
    try {
      const info = await session.getRuntimeInfo();
      expect(info.model).toBe("openrouter-main/b");
    } finally {
      await session.close();
    }
  });
});
