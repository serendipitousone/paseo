import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import {
  loginCodexBrowser,
  loginAndStoreCodex,
  type CodexDeviceCodeInfo,
  type StoredCodexOAuthCredential,
} from "@getpaseo/server";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { connectToDaemon } from "../../utils/client.js";
import { openBrowserUrl } from "../../utils/open-browser.js";
import {
  type CommandError,
  type CommandOptions,
  type OutputSchema,
  type SingleResult,
  withOutput,
} from "../../output/index.js";

// First-class auth UX: `paseo login chatgpt`.
// Default flow is browser OAuth (PKCE + local callback on 127.0.0.1:1455) via Pi's
// helper; credentials are then sent to the selected daemon for storage. `--device-code`
// remains a local-only fallback until a daemon-run device-code RPC exists.

const PROVIDER_INSTANCE = "chatgpt";

interface LoginChatgptOptions extends CommandOptions {
  deviceCode?: boolean;
  home?: string;
}

interface LoginResult {
  provider: string;
  mode: "browser" | "device-code";
  target: string;
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
  write: (message) => console.error(message),
  writeError: (message) => console.error(message),
};

const loginResultSchema: OutputSchema<LoginResult> = {
  idField: "provider",
  columns: [
    { header: "PROVIDER", field: "provider", width: 12 },
    { header: "MODE", field: "mode", width: 12 },
    { header: "TARGET", field: "target", width: 44 },
  ],
  renderHuman: (result) => {
    const data = result.data as LoginResult;
    return `Logged in. Credential stored ${data.mode === "device-code" ? `at ${data.path}` : `on ${data.target}`} in Paseo-owned auth storage.`;
  },
  serialize: (data) => data,
};

function resolveEnv(home: string | undefined): NodeJS.ProcessEnv {
  return home ? { ...process.env, PASEO_HOME: home } : process.env;
}

function requirePaseoAgentConfigFeature(client: Pick<DaemonClient, "getLastServerInfoMessage">) {
  if (client.getLastServerInfoMessage()?.features?.paseoAgentConfig === true) {
    return;
  }
  throw {
    code: "HOST_UPDATE_REQUIRED",
    message: "Update the host to configure Paseo Agent providers.",
  } satisfies CommandError;
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
): Promise<SingleResult<LoginResult>> {
  const env = resolveEnv(options.home);
  const { write } = dependencies;

  if (options.deviceCode && options.host) {
    throw {
      code: "INVALID_LOGIN_OPTIONS",
      message:
        "--device-code cannot be combined with --host yet. Use browser login for remote hosts.",
    } satisfies CommandError;
  }

  if (options.deviceCode) {
    write("Paseo login — ChatGPT/Codex subscription (headless device-code flow)\n");
    const { path } = await dependencies.loginDeviceCode({
      providerInstance: PROVIDER_INSTANCE,
      env,
      onDeviceCode: (info) => printDeviceCode(write, info),
    });
    return {
      type: "single",
      data: {
        provider: "chatgpt",
        mode: "device-code",
        target: path,
        path,
      },
      schema: loginResultSchema,
    };
  }

  const target = formatDaemonTarget(options.host);
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
      throw {
        code: "LOGIN_REJECTED",
        message: result.error ?? "Daemon rejected the ChatGPT credential",
      } satisfies CommandError;
    }
    write(`Credential accepted by ${target}.`);
  } finally {
    await client.close().catch(() => {});
  }

  return {
    type: "single",
    data: {
      provider: "chatgpt",
      mode: "browser",
      target,
      path: target,
    },
    schema: loginResultSchema,
  };
}

export function createLoginCommand(dependencies: Partial<LoginCommandDependencies> = {}): Command {
  const deps = { ...defaultDependencies, ...dependencies };
  const login = new Command("login").description("Authenticate Paseo providers");

  addJsonAndDaemonHostOptions(
    login
      .command("chatgpt")
      .description("Log in to ChatGPT/OpenAI (Codex subscription) for the Paseo Agent provider")
      .option("--device-code", "Use the headless device-code flow instead of the browser flow")
      .option("--home <path>", "Paseo home directory for local --device-code only"),
  ).action(withOutput<LoginResult, []>((options, _command) => runChatgptLogin(options, deps)));

  return login;
}
