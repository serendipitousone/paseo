import { describe, expect, it } from "vitest";

import { createCli } from "../../cli.js";
import { createLoginCommand } from "./index.js";

interface RecordedLogin {
  providerInstance: string;
  envHome: string | undefined;
  mode: "browser" | "device";
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
    expect(flags).toContain("--home");
    // It must not require a copy/paste device flow by default.
    expect(chatgpt?.description().toLowerCase()).toContain("chatgpt");
  });

  it("runs browser login by default and opens the Pi auth URL", async () => {
    const recorded: RecordedLogin[] = [];
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
      loginBrowser: async (options) => {
        recorded.push({
          providerInstance: options.providerInstance,
          envHome: options.env?.PASEO_HOME,
          mode: "browser",
        });
        options.onAuthUrl("https://auth.openai.com/oauth/authorize?client_id=paseo");
        options.onProgress?.("callback complete");
        return { path: "/tmp/paseo-home/paseo-agent/auth.json" };
      },
      loginDeviceCode: async () => {
        throw new Error("device-code login should not be used by default");
      },
    });

    await login.parseAsync(["node", "login", "chatgpt", "--home", "/tmp/paseo-home"]);

    expect(recorded).toEqual([
      { providerInstance: "chatgpt", envHome: "/tmp/paseo-home", mode: "browser" },
    ]);
    expect(openedUrls).toEqual(["https://auth.openai.com/oauth/authorize?client_id=paseo"]);
    expect(output.join("\n")).toContain("browser flow");
    expect(output.join("\n")).toContain("/tmp/paseo-home/paseo-agent/auth.json");
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
      loginBrowser: async () => {
        throw new Error("browser login should not run for --device-code");
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
});
