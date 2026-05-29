import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import {
  loginAndStoreCodex,
  loginAndStoreCodexBrowser,
  type CodexDeviceCodeInfo,
} from "@getpaseo/server";

import { openBrowserUrl } from "../../utils/open-browser.js";

// First-class auth UX: `paseo login chatgpt`.
// Default flow is browser OAuth (PKCE + local callback on 127.0.0.1:1455) via Pi's
// helper; `--device-code` is a headless fallback. Credentials are stored in the
// Paseo-owned store ($PASEO_HOME/paseo-agent/auth.json). No foreign auth files are read.

const PROVIDER_INSTANCE = "chatgpt";

interface LoginChatgptOptions {
  deviceCode?: boolean;
  home?: string;
}

interface LoginResult {
  path: string;
}

interface LoginCommandDependencies {
  loginDeviceCode: typeof loginAndStoreCodex;
  loginBrowser: typeof loginAndStoreCodexBrowser;
  openBrowser: (url: string) => boolean;
  promptForCode: (message: string) => Promise<string>;
  write: (message: string) => void;
  writeError: (message: string) => void;
}

const defaultDependencies: LoginCommandDependencies = {
  loginDeviceCode: loginAndStoreCodex,
  loginBrowser: loginAndStoreCodexBrowser,
  openBrowser: openBrowserUrl,
  promptForCode,
  write: (message) => console.log(message),
  writeError: (message) => console.error(message),
};

function resolveEnv(home: string | undefined): NodeJS.ProcessEnv {
  return home ? { ...process.env, PASEO_HOME: home } : process.env;
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

  write("Paseo login — ChatGPT/Codex subscription (browser flow)\n");
  const { path } = await dependencies.loginBrowser({
    providerInstance: PROVIDER_INSTANCE,
    env,
    onAuthUrl: (url) => {
      const opened = dependencies.openBrowser(url);
      write(
        opened ? "Opening your browser to authorize Paseo…" : "Open this URL to authorize Paseo:",
      );
      write(`  ${url}\n`);
      write("Waiting for you to approve in the browser…");
      write("(If the browser didn't open, copy the URL above. You can also paste the code here.)");
    },
    onProgress: (message) => write(message),
    promptForCode: dependencies.promptForCode,
  });
  write(`\n✓ Logged in. Credential stored at ${path} (Paseo-owned, mode 0600).`);
  return { path };
}

export function createLoginCommand(dependencies: Partial<LoginCommandDependencies> = {}): Command {
  const deps = { ...defaultDependencies, ...dependencies };
  const login = new Command("login").description("Authenticate Paseo providers");

  login
    .command("chatgpt")
    .description("Log in to ChatGPT/OpenAI (Codex subscription) for the Paseo Agent provider")
    .option("--device-code", "Use the headless device-code flow instead of the browser flow")
    .option("--home <path>", "Paseo home directory (default: ~/.paseo or $PASEO_HOME)")
    .action(async (options: LoginChatgptOptions) => {
      try {
        await runChatgptLogin(options, deps);
      } catch (error) {
        deps.writeError(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  return login;
}
