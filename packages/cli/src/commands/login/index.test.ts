import { describe, expect, it, vi } from "vitest";

import { createCli } from "../../cli.js";
import { createLoginCommand } from "./index.js";

interface RecordedLogin {
  mode: "browser" | "device";
  providerInstance?: string;
  envHome?: string | undefined;
}

describe("paseo login command", () => {
  it("is registered on the top-level CLI", () => {
    const program = createCli();
    const login = program.commands.find((command) => command.name() === "login");
    expect(login).toBeDefined();
  });

  it("exposes a `chatgpt` subcommand with browser default + headless flag", () => {
    const login = createLoginCommand();
    const chatgpt = login.commands.find((command) => command.name() === "chatgpt");
    expect(chatgpt).toBeDefined();

    const flags = chatgpt?.options.map((option) => option.long);
    // Default flow is browser; device-code is an opt-in fallback.
    expect(flags).toContain("--device-code");
    expect(flags).toContain("--host");
    expect(flags).toContain("--home");
    // It must not require a copy/paste device flow by default.
    expect(chatgpt?.description().toLowerCase()).toContain("chatgpt");
  });

  it("runs browser login by default and stores the credential through the daemon", async () => {
    const recorded: RecordedLogin[] = [];
    const stored: unknown[] = [];
    const openedUrls: string[] = [];
    const output: string[] = [];

    const login = createLoginCommand({
      write: (message) => output.push(message),
      writeError: (message) => output.push(message),
      openBrowser: (url) => {
        openedUrls.push(url);
        return true;
      },
      promptForCode: async () => {
        throw new Error("manual code prompt should not be used for successful browser login");
      },
      loginBrowserCredential: async (options) => {
        recorded.push({ mode: "browser" });
        options.onAuthUrl("https://auth.openai.com/oauth/authorize?client_id=paseo");
        options.onProgress?.("callback complete");
        return { type: "oauth", access: "access-token", refresh: "refresh-token", expires: 123 };
      },
      connectDaemon: async (options) => {
        expect(options.host).toBe("localhost:7777");
        return {
          getLastServerInfoMessage: () => ({
            status: "server_info",
            serverId: "test-daemon",
            features: { paseoAgentConfig: true },
          }),
          storePaseoAgentChatGptCredential: async (input) => {
            stored.push(input);
            return {
              requestId: "request-1",
              success: true,
              providerName: input.providerName,
              auth: { kind: "oauth", configured: true, source: "stored" },
              error: null,
            };
          },
          close: async () => {},
        };
      },
      loginDeviceCode: async () => {
        throw new Error("device-code login should not be used by default");
      },
    });

    await login.parseAsync(["node", "login", "chatgpt", "--host", "localhost:7777"]);

    expect(recorded).toEqual([{ mode: "browser" }]);
    expect(stored).toEqual([
      {
        providerName: "chatgpt",
        credential: {
          type: "oauth",
          access: "access-token",
          refresh: "refresh-token",
          expires: 123,
        },
      },
    ]);
    expect(openedUrls).toEqual(["https://auth.openai.com/oauth/authorize?client_id=paseo"]);
    expect(output.join("\n")).toContain("browser flow");
    expect(output.join("\n")).toContain("selected daemon (localhost:7777)");
    expect(output.join("\n")).not.toContain("access-token");
    expect(output.join("\n")).not.toContain("refresh-token");
  });

  it("uses device-code login only when explicitly requested", async () => {
    const recorded: RecordedLogin[] = [];
    const output: string[] = [];

    const login = createLoginCommand({
      write: (message) => output.push(message),
      writeError: (message) => output.push(message),
      openBrowser: () => {
        throw new Error("browser opener should not run for --device-code");
      },
      promptForCode: async () => {
        throw new Error("manual browser prompt should not run for --device-code");
      },
      loginBrowserCredential: async () => {
        throw new Error("browser login should not run for --device-code");
      },
      connectDaemon: async () => {
        throw new Error("daemon client should not be used for local --device-code");
      },
      loginDeviceCode: async (options) => {
        recorded.push({
          providerInstance: options.providerInstance,
          envHome: options.env?.PASEO_HOME,
          mode: "device",
        });
        options.onDeviceCode({
          userCode: "ABCD-EFGH",
          verificationUri: "https://auth.openai.com/codex/device",
          intervalSeconds: 5,
          expiresInSeconds: 900,
        });
        return { path: "/tmp/paseo-home/paseo-agent/auth.json" };
      },
    });

    await login.parseAsync([
      "node",
      "login",
      "chatgpt",
      "--device-code",
      "--home",
      "/tmp/paseo-home",
    ]);

    expect(recorded).toEqual([
      { providerInstance: "chatgpt", envHome: "/tmp/paseo-home", mode: "device" },
    ]);
    expect(output.join("\n")).toContain("headless device-code flow");
    expect(output.join("\n")).toContain("ABCD-EFGH");
  });

  it("rejects --device-code with --host instead of writing local auth for a remote host", async () => {
    const output: string[] = [];
    const stderr: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    const login = createLoginCommand({
      write: (message) => output.push(message),
      writeError: (message) => output.push(message),
      openBrowser: () => {
        throw new Error("browser opener should not run");
      },
      promptForCode: async () => {
        throw new Error("prompt should not run");
      },
      loginBrowserCredential: async () => {
        throw new Error("browser login should not run");
      },
      loginDeviceCode: async () => {
        throw new Error("device-code login should not run with --host");
      },
      connectDaemon: async () => {
        throw new Error("daemon client should not be used");
      },
    });

    await expect(
      login.parseAsync(["node", "login", "chatgpt", "--device-code", "--host", "remote:7777"]),
    ).rejects.toThrow("process.exit unexpectedly called");
    stderrSpy.mockRestore();

    expect(stderr.join("\n")).toContain("--device-code cannot be combined with --host");
  });

  it("asks for a host update instead of sending credentials to an old daemon", async () => {
    const stored: unknown[] = [];
    const output: string[] = [];
    const stderr: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    const login = createLoginCommand({
      write: (message) => output.push(message),
      writeError: (message) => output.push(message),
      openBrowser: () => {
        throw new Error("browser opener should not run without the capability flag");
      },
      promptForCode: async () => {
        throw new Error("manual code prompt should not be used");
      },
      loginBrowserCredential: async () => {
        throw new Error("browser login should not run without the capability flag");
      },
      connectDaemon: async () => ({
        getLastServerInfoMessage: () => ({
          status: "server_info",
          serverId: "test-daemon",
          features: {},
        }),
        storePaseoAgentChatGptCredential: async (input) => {
          stored.push(input);
          throw new Error("store RPC should not be called without the capability flag");
        },
        close: async () => {},
      }),
      loginDeviceCode: async () => {
        throw new Error("device-code login should not run");
      },
    });

    await expect(
      login.parseAsync(["node", "login", "chatgpt", "--host", "remote:7777"]),
    ).rejects.toThrow("process.exit unexpectedly called");
    stderrSpy.mockRestore();

    expect(stored).toEqual([]);
    expect(stderr.join("\n")).toContain("Update the host to configure Paseo Agent providers.");
  });

  it("does not echo password-bearing host URIs after remote login", async () => {
    const output: string[] = [];
    const login = createLoginCommand({
      write: (message) => output.push(message),
      writeError: (message) => output.push(message),
      openBrowser: () => true,
      promptForCode: async () => {
        throw new Error("manual code prompt should not be used");
      },
      loginBrowserCredential: async () => ({
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: 123,
      }),
      connectDaemon: async () => ({
        getLastServerInfoMessage: () => ({
          status: "server_info",
          serverId: "test-daemon",
          features: { paseoAgentConfig: true },
        }),
        storePaseoAgentChatGptCredential: async (input) => ({
          requestId: "request-1",
          success: true,
          providerName: input.providerName,
          auth: { kind: "oauth", configured: true, source: "stored" },
          error: null,
        }),
        close: async () => {},
      }),
      loginDeviceCode: async () => {
        throw new Error("device-code login should not run");
      },
    });

    await login.parseAsync([
      "node",
      "login",
      "chatgpt",
      "--host",
      "tcp://remote:7777?ssl=true&password=super-secret",
    ]);

    expect(output.join("\n")).toContain("tcp://remote:7777?ssl=true");
    expect(output.join("\n")).not.toContain("super-secret");
  });
});
