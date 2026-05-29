import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasStoredOAuthCredential,
  loginAndStoreCodex,
  loginAndStoreCodexBrowser,
  paseoAgentAuthStoragePath,
} from "./oauth-store.js";

describe("oauth-store", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "paseo-oauth-store-"));
    env = { PASEO_HOME: home };
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("derives the store path from PASEO_HOME", () => {
    expect(paseoAgentAuthStoragePath(env)).toBe(join(home, "paseo-agent", "auth.json"));
  });

  it("reports no stored credential before login", () => {
    expect(hasStoredOAuthCredential("chatgpt", env)).toBe(false);
  });

  it("runs the Pi login helper and persists a Paseo-owned credential", async () => {
    const loginCalls: string[] = [];
    const deviceCodes: unknown[] = [];
    const login = async (opts: { onDeviceCode: (info: unknown) => void }) => {
      loginCalls.push("called");
      opts.onDeviceCode({
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.openai.com/codex/device",
        intervalSeconds: 5,
        expiresInSeconds: 900,
      });
      return { refresh: "rt-from-login", access: "ac", expires: 123, accountId: "acct" };
    };

    const { path } = await loginAndStoreCodex({
      providerInstance: "chatgpt",
      env,
      onDeviceCode: (info) => deviceCodes.push(info),
      login,
    });

    expect(loginCalls).toEqual(["called"]);
    expect(deviceCodes).toEqual([expect.objectContaining({ userCode: "ABCD-EFGH" })]);
    expect(path).toBe(join(home, "paseo-agent", "auth.json"));

    // Credential persisted to the Paseo-owned store (not any foreign file).
    expect(hasStoredOAuthCredential("chatgpt", env)).toBe(true);
    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored.chatgpt).toMatchObject({ type: "oauth", refresh: "rt-from-login" });

    // Stored private (0600).
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("keys the credential by provider instance name", async () => {
    const login = async () => ({ refresh: "rt", access: "", expires: 0 });
    await loginAndStoreCodex({
      providerInstance: "work-chatgpt",
      env,
      onDeviceCode: () => {},
      login,
    });
    expect(hasStoredOAuthCredential("work-chatgpt", env)).toBe(true);
    expect(hasStoredOAuthCredential("chatgpt", env)).toBe(false);
  });

  it("browser login surfaces the auth URL and persists a Paseo-owned credential", async () => {
    const authUrls: Array<[string, string | undefined]> = [];
    const loginCalls: string[] = [];
    // Fake Pi browser-login helper: emits an auth URL, returns credentials.
    const login = async (opts: { onAuth: (info: { url: string }) => void }) => {
      loginCalls.push("called");
      opts.onAuth({ url: "https://auth.openai.com/oauth/authorize?x=1" });
      return { refresh: "rt-browser", access: "ac", expires: 456, accountId: "acct" };
    };

    const { path } = await loginAndStoreCodexBrowser({
      providerInstance: "chatgpt",
      env,
      onAuthUrl: (url, instructions) => authUrls.push([url, instructions]),
      login,
    });

    expect(loginCalls).toEqual(["called"]);
    expect(authUrls).toEqual([["https://auth.openai.com/oauth/authorize?x=1", undefined]]);
    expect(path).toBe(join(home, "paseo-agent", "auth.json"));
    expect(hasStoredOAuthCredential("chatgpt", env)).toBe(true);
    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored.chatgpt).toMatchObject({ type: "oauth", refresh: "rt-browser" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("browser login falls back to manual code entry only when the callback can't complete", async () => {
    const prompts: string[] = [];
    const promptForCode = async (message: string) => {
      prompts.push(message);
      return "pasted-code";
    };
    // Fake helper that cannot complete via callback and invokes onPrompt.
    const login = async (opts: { onPrompt: (p: { message: string }) => Promise<string> }) => {
      const code = await opts.onPrompt({ message: "Paste the code:" });
      expect(code).toBe("pasted-code");
      return { refresh: "rt-manual", access: "", expires: 0 };
    };

    await loginAndStoreCodexBrowser({
      providerInstance: "chatgpt",
      env,
      onAuthUrl: () => {},
      promptForCode,
      login,
    });

    expect(prompts).toEqual(["Paste the code:"]);
    expect(hasStoredOAuthCredential("chatgpt", env)).toBe(true);
  });
});
