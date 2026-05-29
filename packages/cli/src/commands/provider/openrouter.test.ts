import { describe, expect, it } from "vitest";

import { render } from "../../output/index.js";
import { runAddOpenRouterCommand } from "./openrouter.js";

describe("provider add openrouter", () => {
  it("sends OpenRouter config to the selected daemon and redacts output", async () => {
    const calls: unknown[] = [];
    const result = await runAddOpenRouterCommand(
      "openrouter-main",
      {
        host: "localhost:7777",
        apiKeyStdin: true,
        model: ["anthropic/claude-3.7-sonnet", "openai/gpt-4o"],
      },
      {} as never,
      {
        readStdin: async () => "redaction-sentinel\n",
        env: {},
        connectDaemon: async (options) => {
          expect(options.host).toBe("localhost:7777");
          return {
            getLastServerInfoMessage: () => ({
              status: "server_info",
              serverId: "test-daemon",
              features: { paseoAgentConfig: true },
            }),
            setPaseoAgentProvider: async (input) => {
              calls.push(input);
              return {
                requestId: "request-1",
                success: true,
                provider: {
                  name: input.name,
                  providerType: "openrouter",
                  models: input.options.models,
                  auth: { kind: "api_key", configured: true, source: "literal" },
                  available: true,
                  error: null,
                },
                error: null,
              };
            },
            close: async () => {},
          };
        },
      },
    );

    expect(calls).toEqual([
      {
        name: "openrouter-main",
        providerType: "openrouter",
        options: {
          apiKey: "redaction-sentinel",
          models: [{ id: "anthropic/claude-3.7-sonnet" }, { id: "openai/gpt-4o" }],
        },
      },
    ]);

    const json = render(result, { format: "json" });
    const table = render(result, { format: "table", noColor: true });
    expect(json).not.toContain("redaction-sentinel");
    expect(table).not.toContain("redaction-sentinel");
    expect(table).toContain("openrouter-main");
    expect(table).toContain("anthropic/claude-3.7-sonnet");
  });

  it("uses OPENROUTER_API_KEY by default and requires explicit models", async () => {
    await expect(
      runAddOpenRouterCommand("openrouter-main", { model: [] }, {} as never, {
        env: { OPENROUTER_API_KEY: "redaction-sentinel" },
        readStdin: async () => {
          throw new Error("stdin should not be read");
        },
        connectDaemon: async () => {
          throw new Error("daemon should not be called without models");
        },
      }),
    ).rejects.toMatchObject({ code: "MISSING_MODELS" });
  });

  it("asks for a host update instead of sending provider config to an old daemon", async () => {
    const calls: unknown[] = [];

    await expect(
      runAddOpenRouterCommand(
        "openrouter-main",
        {
          host: "localhost:7777",
          apiKeyStdin: true,
          model: ["anthropic/claude-3.7-sonnet"],
        },
        {} as never,
        {
          readStdin: async () => "redaction-sentinel\n",
          env: {},
          connectDaemon: async () => ({
            getLastServerInfoMessage: () => ({
              status: "server_info",
              serverId: "test-daemon",
              features: {},
            }),
            setPaseoAgentProvider: async (input) => {
              calls.push(input);
              throw new Error("set provider RPC should not run without the capability flag");
            },
            close: async () => {},
          }),
        },
      ),
    ).rejects.toMatchObject({
      code: "HOST_UPDATE_REQUIRED",
      message: "Update the host to configure Paseo Agent providers.",
    });

    expect(calls).toEqual([]);
  });
});
