import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import {
  loginCodexBrowser,
  loginAndStoreCodex,
  type CodexDeviceCodeInfo,
  type StoredCodexOAuthCredential,
} from "@getpaseo/server";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

import { addDaemonHostOption } from "../../utils/command-options.js";
import { connectToDaemon } from "../../utils/client.js";
import { openBrowserUrl } from "../../utils/open-browser.js";

// First-class auth UX: `paseo login chatgpt`.
// Default flow is browser OAuth (PKCE + local callback on 127.0.0.1:1455) via Pi's
// helper; credentials are then sent to the selected daemon for storage. `--device-code`
// remains a local-only fallback until a daemon-run device-code RPC exists.

const PROVIDER_INSTANCE = "chatgpt";

interface LoginChatgptOptions {
  deviceCode?: boolean;
  home?: string;
  host?: string;
}

interface LoginResult {
  path: string;
}

interface LoginCommandDependencies {
  loginDeviceCode: typeof loginAndStoreCodex;
  loginBrowserCredential: typeof loginCodexBrowser;
  connectDaemon: (options: {
    host?: string;
  }) => Promise<
    Pick<DaemonClient, "getLastServerInfoMessage" | "storePaseoAgentChatGptCredential" | "close">
  >;
  openBrowser: (url: string) => boolean;
  promptForCode: (message: string) => Promise<string>;
  write: (message: string) => void;
  writeError: (message: string) => void;
}

const defaultDependencies: LoginCommandDependencies = {
  loginDeviceCode: loginAndStoreCodex,
  loginBrowserCredential: loginCodexBrowser,
  connectDaemon: connectToDaemon,
  openBrowser: openBrowserUrl,
  promptForCode,
  write: (message) => console.log(message),
  writeError: (message) => console.error(message),
};

function resolveEnv(home: string | undefined): NodeJS.ProcessEnv {
  return home ? { ...process.env, PASEO_HOME: home } : process.env;
}

function requirePaseoAgentConfigFeature(client: Pick<DaemonClient, "getLastServerInfoMessage">) {
  if (client.getLastServerInfoMessage()?.features?.paseoAgentConfig === true) {
    return;
  }
  throw new Error("Update the host to configure Paseo Agent providers.");
}

function formatDaemonTarget(host: string | undefined): string {
  if (!host) {
    return "local daemon";
  }
  try {
    if (host.startsWith("tcp://")) {
      const url = new URL(host);
      url.searchParams.delete("password");
      return `selected daemon (${url.toString()})`;
    }
  } catch {
    // Invalid hosts fail during connection; this path only formats the success message.
  }
  return `selected daemon (${host})`;
}

async function promptForCode(message: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${message} `)).trim();
  } finally {
    rl.close();
  }
}

function printDeviceCode(write: (message: string) => void, info: CodexDeviceCodeInfo): void {
  write("To authorize Paseo:");
  write(`  1. Open: ${info.verificationUri}`);
  write(`  2. Enter code: ${info.userCode}`);
  write(`  (expires in ~${Math.round(info.expiresInSeconds / 60)} min — waiting...)\n`);
}

async function runChatgptLogin(
  options: LoginChatgptOptions,
  dependencies: LoginCommandDependencies,
): Promise<LoginResult> {
  const env = resolveEnv(options.home);
  const { write } = dependencies;

  if (options.deviceCode && options.host) {
    throw new Error(
      "--device-code cannot be combined with --host yet. Use browser login for remote hosts.",
    );
  }

  if (options.deviceCode) {
    write("Paseo login — ChatGPT/Codex subscription (headless device-code flow)\n");
    const { path } = await dependencies.loginDeviceCode({
      providerInstance: PROVIDER_INSTANCE,
      env,
      onDeviceCode: (info) => printDeviceCode(write, info),
    });
    write(`\n✓ Logged in. Credential stored at ${path} (Paseo-owned, mode 0600).`);
    return { path };
  }

  const client = await dependencies.connectDaemon({ host: options.host });
  try {
    requirePaseoAgentConfigFeature(client);
    write("Paseo login — ChatGPT/Codex subscription (browser flow)\n");
    const credential: StoredCodexOAuthCredential = await dependencies.loginBrowserCredential({
      onAuthUrl: (url) => {
        const opened = dependencies.openBrowser(url);
        write(
          opened ? "Opening your browser to authorize Paseo…" : "Open this URL to authorize Paseo:",
        );
        write(`  ${url}\n`);
        write("Waiting for you to approve in the browser…");
        write(
          "(If the browser didn't open, copy the URL above. You can also paste the code here.)",
        );
      },
      onProgress: (message) => write(message),
      promptForCode: dependencies.promptForCode,
    });
    const result = await client.storePaseoAgentChatGptCredential({
      providerName: PROVIDER_INSTANCE,
      credential,
    });
    if (!result.success || result.error) {
      throw new Error(result.error ?? "Daemon rejected the ChatGPT credential");
    }
  } finally {
    await client.close().catch(() => {});
  }

  const target = formatDaemonTarget(options.host);
  write(`\n✓ Logged in. Credential stored on ${target} in its Paseo-owned auth store.`);
  return { path: target };
}

export function createLoginCommand(dependencies: Partial<LoginCommandDependencies> = {}): Command {
  const deps = { ...defaultDependencies, ...dependencies };
  const login = new Command("login").description("Authenticate Paseo providers");

  addDaemonHostOption(
    login
      .command("chatgpt")
      .description("Log in to ChatGPT/OpenAI (Codex subscription) for the Paseo Agent provider")
      .option("--device-code", "Use the headless device-code flow instead of the browser flow")
      .option("--home <path>", "Paseo home directory for local --device-code only"),
  ).action(async (options: LoginChatgptOptions) => {
    try {
      await runChatgptLogin(options, deps);
    } catch (error) {
      deps.writeError(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

  return login;
}
