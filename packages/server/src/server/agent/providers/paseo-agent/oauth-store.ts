import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { loginOpenAICodex, loginOpenAICodexDeviceCode } from "@earendil-works/pi-ai/oauth";

// Paseo-owned OAuth credential store for the Paseo Agent provider. Credentials live
// in a Paseo-controlled file (NOT ~/.pi, ~/.codex, OpenCode, or any other tool's
// store) and are managed through Pi's own AuthStorage, so Pi refreshes tokens and
// persists rotation back into Paseo's file. The login flows reuse Pi's OAuth helpers
// (browser PKCE/callback by default, device-code as a headless fallback) — Paseo does
// not reimplement the OAuth protocol.

export interface CodexDeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

type DeviceCodeLogin = (options: {
  onDeviceCode: (info: CodexDeviceCodeInfo) => void;
  signal?: AbortSignal;
}) => Promise<OAuthCredentials>;

type BrowserLogin = (options: {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onPrompt: (prompt: { message: string }) => Promise<string>;
  onProgress?: (message: string) => void;
}) => Promise<OAuthCredentials>;

/** Path to the Paseo-owned auth store. Uses PASEO_HOME; falls back to ~/.paseo. */
export function paseoAgentAuthStoragePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.PASEO_HOME ?? join(homedir(), ".paseo");
  return join(base, "paseo-agent", "auth.json");
}

/**
 * Pi AuthStorage backed by the Paseo-owned file. Pi creates the parent dir (0700) and
 * the file (0600) and re-chmods on every write, so refreshed tokens stay private.
 */
export function createPaseoAgentAuthStorage(env: NodeJS.ProcessEnv = process.env): AuthStorage {
  return AuthStorage.create(paseoAgentAuthStoragePath(env));
}

/**
 * Read-only check (no file creation) for whether a Paseo-owned OAuth credential exists
 * for a provider instance. Used for availability without constructing AuthStorage.
 */
export function hasStoredOAuthCredential(
  providerInstance: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const path = paseoAgentAuthStoragePath(env);
  if (!existsSync(path)) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return false;
    }
    const entry = (parsed as Record<string, unknown>)[providerInstance];
    return (
      typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "oauth"
    );
  } catch {
    return false;
  }
}

/**
 * Run Pi's ChatGPT/Codex device-code OAuth login and persist the resulting credential
 * into the Paseo-owned store under `providerInstance`. The `login` dependency defaults
 * to Pi's helper and is injectable for tests (no network). Never reads foreign files.
 */
export async function loginAndStoreCodex(options: {
  providerInstance: string;
  onDeviceCode: (info: CodexDeviceCodeInfo) => void;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  login?: DeviceCodeLogin;
}): Promise<{ path: string }> {
  const login = options.login ?? (loginOpenAICodexDeviceCode as DeviceCodeLogin);
  const credentials = await login({ onDeviceCode: options.onDeviceCode, signal: options.signal });
  const path = paseoAgentAuthStoragePath(options.env);
  const authStorage = AuthStorage.create(path);
  authStorage.set(options.providerInstance, { type: "oauth", ...credentials });
  return { path };
}

/**
 * Run Pi's ChatGPT/Codex **browser** OAuth login (PKCE + local callback on
 * 127.0.0.1:1455) and persist the resulting credential into the Paseo-owned store.
 * This is the default, first-class login UX. `onAuthUrl` receives the authorization
 * URL (the caller opens it / prints it); `promptForCode` is a fallback used only if
 * the browser callback can't complete (manual code paste). The `login` dependency
 * defaults to Pi's helper and is injectable for tests. Never reads foreign files.
 */
export async function loginAndStoreCodexBrowser(options: {
  providerInstance: string;
  onAuthUrl: (url: string, instructions?: string) => void;
  promptForCode?: (message: string) => Promise<string>;
  onProgress?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  login?: BrowserLogin;
}): Promise<{ path: string }> {
  const login = options.login ?? (loginOpenAICodex as BrowserLogin);
  const credentials = await login({
    onAuth: (info) => options.onAuthUrl(info.url, info.instructions),
    onProgress: options.onProgress,
    onPrompt: async (prompt) => {
      if (!options.promptForCode) {
        throw new Error("Browser login did not complete and no manual code entry was available.");
      }
      return options.promptForCode(prompt.message);
    },
  });
  const path = paseoAgentAuthStoragePath(options.env);
  const authStorage = AuthStorage.create(path);
  authStorage.set(options.providerInstance, { type: "oauth", ...credentials });
  return { path };
}
