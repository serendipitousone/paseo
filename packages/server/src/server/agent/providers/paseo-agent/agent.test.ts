import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentSessionConfig } from "../../agent-sdk-types.js";
import { PaseoAgentClient } from "./agent.js";
import { PaseoAgentConfigSchema, type PaseoAgentConfig } from "./config.js";
import { storeCodexOAuthCredential } from "./oauth-store.js";

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

function createRecordingLogger(): Logger & { warnings: Array<{ data: unknown; message: string }> } {
  const warnings: Array<{ data: unknown; message: string }> = [];
  const logger = {
    warnings,
    child: () => logger,
    debug: () => {},
    warn: (data: unknown, message: string) => {
      warnings.push({ data, message });
    },
    error: () => {},
    info: () => {},
  } as Logger & { warnings: Array<{ data: unknown; message: string }> };
  return logger;
}

describe("PaseoAgentClient", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is available only when config has a usable inference provider", async () => {
    const withConfig = new PaseoAgentClient({ logger: createTestLogger(), config: makeConfig() });
    expect(await withConfig.isAvailable()).toBe(true);

    const empty = new PaseoAgentClient({
      logger: createTestLogger(),
      config: PaseoAgentConfigSchema.parse({}),
    });
    expect(await empty.isAvailable()).toBe(false);
  });

  it("checks ChatGPT OAuth credentials in the configured Paseo home", async () => {
    const paseoHome = mkdtempSync(join(tmpdir(), "paseo-agent-client-"));
    const wrongHome = mkdtempSync(join(tmpdir(), "paseo-agent-wrong-home-"));
    tempDirs.push(paseoHome, wrongHome);
    const previousPaseoHome = process.env.PASEO_HOME;
    process.env.PASEO_HOME = wrongHome;
    storeCodexOAuthCredential({
      providerInstance: "chatgpt",
      credential: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: 0 },
      env: { PASEO_HOME: paseoHome },
    });
    const config = PaseoAgentConfigSchema.parse({
      providers: {
        chatgpt: {
          type: "openai-codex",
          options: { models: [{ id: "gpt-5.3-codex" }] },
        },
      },
    });

    try {
      const client = new PaseoAgentClient({ logger: createTestLogger(), config, paseoHome });
      expect(await client.isAvailable()).toBe(true);
    } finally {
      if (previousPaseoHome === undefined) {
        delete process.env.PASEO_HOME;
      } else {
        process.env.PASEO_HOME = previousPaseoHome;
      }
    }
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

  it("uses the configured default prompt profile as a lowest-precedence model default", async () => {
    const paseoHome = mkdtempSync(join(tmpdir(), "paseo-agent-client-"));
    tempDirs.push(paseoHome);
    mkdirSync(join(paseoHome, "agents"), { recursive: true });
    writeFileSync(
      join(paseoHome, "agents", "orchestrator.md"),
      `---
model: openrouter-main/b
---
Profile prompt.
`,
    );
    const config = PaseoAgentConfigSchema.parse({
      defaultProfile: "orchestrator",
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
    const client = new PaseoAgentClient({ logger: createTestLogger(), config, paseoHome });
    const session = await client.createSession(sessionConfig());
    try {
      const info = await session.getRuntimeInfo();
      expect(info.model).toBe("openrouter-main/b");
    } finally {
      await session.close();
    }
  });

  it("prefers the configured default model over the profile default model", async () => {
    const paseoHome = mkdtempSync(join(tmpdir(), "paseo-agent-client-"));
    tempDirs.push(paseoHome);
    mkdirSync(join(paseoHome, "agents"), { recursive: true });
    writeFileSync(
      join(paseoHome, "agents", "orchestrator.md"),
      `---
model: openrouter-main/b
---
Profile prompt.
`,
    );
    const config = PaseoAgentConfigSchema.parse({
      defaultProfile: "orchestrator",
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
    const client = new PaseoAgentClient({ logger: createTestLogger(), config, paseoHome });
    const session = await client.createSession(sessionConfig());
    try {
      const info = await session.getRuntimeInfo();
      expect(info.model).toBe("openrouter-main/a");
    } finally {
      await session.close();
    }
  });

  it("warns when the configured profile expects a missing MCP server", async () => {
    const paseoHome = mkdtempSync(join(tmpdir(), "paseo-agent-client-"));
    tempDirs.push(paseoHome);
    mkdirSync(join(paseoHome, "agents"), { recursive: true });
    writeFileSync(
      join(paseoHome, "agents", "orchestrator.md"),
      `---
mcp: [paseo, paseo]
---
Profile prompt.
`,
    );
    const logger = createRecordingLogger();
    const client = new PaseoAgentClient({
      logger,
      config: PaseoAgentConfigSchema.parse({ ...makeConfig(), defaultProfile: "orchestrator" }),
      paseoHome,
    });
    const session = await client.createSession(sessionConfig());
    try {
      expect(logger.warnings).toEqual([
        {
          data: expect.objectContaining({ mcpServer: "paseo" }),
          message: expect.stringMatching(/expects an MCP server/i),
        },
      ]);
    } finally {
      await session.close();
    }
  });
});
