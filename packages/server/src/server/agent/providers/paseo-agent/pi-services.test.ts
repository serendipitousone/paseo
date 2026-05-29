import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type CreatePaseoAgentSessionOptions,
  type PaseoAgentInferenceProvider,
  createPaseoAgentSession,
} from "./pi-services.js";

function codexInferenceProvider(): PaseoAgentInferenceProvider {
  return {
    name: "chatgpt",
    config: {
      baseUrl: "https://chatgpt.com/backend-api",
      api: "openai-codex-responses",
      models: [
        {
          id: "gpt-5.3-codex",
          name: "gpt-5.3-codex",
          api: "openai-codex-responses",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        },
      ],
    },
  };
}

const FAKE_PROVIDER = "paseo-test-openrouter";
const FAKE_MODEL_ID = "test-model";

function fakeInferenceProvider(): PaseoAgentInferenceProvider {
  return {
    name: FAKE_PROVIDER,
    config: {
      baseUrl: "https://example.invalid/v1",
      apiKey: "sk-in-memory-only",
      api: "openai-completions",
      models: [
        {
          id: FAKE_MODEL_ID,
          name: "Paseo Test Model",
          api: "openai-completions",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        },
      ],
    },
  };
}

describe("createPaseoAgentSession (no-discovery spike)", () => {
  let cwd: string;
  let agentDir: string;
  let fakeHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "paseo-agent-cwd-"));
    agentDir = join(mkdtempSync(join(tmpdir(), "paseo-agent-dir-")), "agent");
    fakeHome = mkdtempSync(join(tmpdir(), "paseo-agent-home-"));
    // Redirect HOME so any accidental ~/.pi discovery would land in fakeHome and be detectable.
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    for (const dir of [cwd, fakeHome, agentDir]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function baseOptions(): CreatePaseoAgentSessionOptions {
    return {
      cwd,
      agentDir,
      inferenceProviders: [fakeInferenceProvider()],
      model: { provider: FAKE_PROVIDER, id: FAKE_MODEL_ID },
    };
  }

  it("creates a session from an in-memory inference provider and selects its model", async () => {
    const { session, modelRegistry } = await createPaseoAgentSession(baseOptions());

    expect(session).toBeDefined();
    expect(session.model?.provider).toBe(FAKE_PROVIDER);
    expect(session.model?.id).toBe(FAKE_MODEL_ID);
    // The in-memory model is the only one reachable with configured auth.
    const available = modelRegistry.getAvailable();
    expect(available.some((m) => m.provider === FAKE_PROVIDER && m.id === FAKE_MODEL_ID)).toBe(
      true,
    );
  });

  it("performs no Pi resource discovery", async () => {
    const { resourceLoader } = await createPaseoAgentSession(baseOptions());

    expect(resourceLoader.getSkills().skills).toHaveLength(0);
    expect(resourceLoader.getExtensions().extensions).toHaveLength(0);
    expect(resourceLoader.getPrompts().prompts).toHaveLength(0);
  });

  it("uses an in-memory session manager with no on-disk session file", async () => {
    const { sessionManager } = await createPaseoAgentSession(baseOptions());

    expect(sessionManager.getSessionFile()).toBeUndefined();
  });

  it("touches no ~/.pi config and writes nothing to the isolated agentDir", async () => {
    await createPaseoAgentSession(baseOptions());

    // No discovery against the redirected home directory: if Pi resolved its
    // default agentDir (~/.pi/agent) it would create or read it under fakeHome.
    expect(existsSync(join(fakeHome, ".pi"))).toBe(false);
    // Nothing persisted to the Paseo-owned isolated agentDir.
    const agentDirContents = existsSync(agentDir) ? readdirSync(agentDir) : [];
    expect(agentDirContents).toHaveLength(0);
    // No session/auth/model files leaked into the cwd either.
    expect(existsSync(join(cwd, ".pi"))).toBe(false);
  });

  it("rejects a model that no inference provider registered", async () => {
    await expect(
      createPaseoAgentSession({
        ...baseOptions(),
        inferenceProviders: [],
      }),
    ).rejects.toThrow(/not registered/);
  });

  it("activates supplied custom tools alongside the built-in tools", async () => {
    const { session } = await createPaseoAgentSession({
      ...baseOptions(),
      customTools: [
        {
          name: "paseo__demo",
          label: "demo",
          description: "demo tool",
          parameters: { type: "object" } as never,
          async execute() {
            return { content: [{ type: "text", text: "ok" }], details: null };
          },
        },
      ],
    });

    const active = session.getActiveToolNames();
    expect(active).toContain("paseo__demo");
    // Built-in tools remain active too.
    expect(active).toContain("bash");
  });

  it("registers a codex provider and seeds the advanced refresh-token override", async () => {
    const codex = codexInferenceProvider();
    const { session, modelRegistry } = await createPaseoAgentSession({
      cwd,
      agentDir,
      model: { provider: "chatgpt", id: "gpt-5.3-codex" },
      inferenceProviders: [
        { ...codex, oauth: { kind: "openai-codex", refreshToken: "rt-test-only" } },
      ],
    });

    expect(session.model?.provider).toBe("chatgpt");
    expect(modelRegistry.find("chatgpt", "gpt-5.3-codex")?.api).toBe("openai-codex-responses");
    const available = modelRegistry.getAvailable();
    expect(available.some((m) => m.provider === "chatgpt" && m.id === "gpt-5.3-codex")).toBe(true);
  });

  it("loads a codex credential from a Paseo-owned AuthStorage (product path)", async () => {
    // Simulate the result of `paseo login chatgpt`: a credential already in the store.
    const authPath = join(mkdtempSync(join(tmpdir(), "paseo-agent-auth-")), "auth.json");
    const authStorage = AuthStorage.create(authPath);
    authStorage.set("chatgpt", { type: "oauth", access: "", refresh: "rt-stored", expires: 0 });

    const { modelRegistry } = await createPaseoAgentSession({
      cwd,
      agentDir,
      authStorage,
      model: { provider: "chatgpt", id: "gpt-5.3-codex" },
      // No oauth.refreshToken marker — the credential comes from the Paseo store.
      inferenceProviders: [{ ...codexInferenceProvider(), oauth: { kind: "openai-codex" } }],
    });

    const available = modelRegistry.getAvailable();
    expect(available.some((m) => m.provider === "chatgpt" && m.id === "gpt-5.3-codex")).toBe(true);
    rmSync(authPath, { force: true });
  });
});
