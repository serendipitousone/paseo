import type { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { RedactedPaseoAgentProviderConfig } from "@getpaseo/protocol/messages";

import { connectToDaemon } from "../../utils/client.js";
import { collectMultiple } from "../../utils/command-options.js";
import type { CommandOptions, OutputSchema, SingleResult } from "../../output/index.js";

interface OpenRouterAddOptions extends CommandOptions {
  apiKey?: string;
  apiKeyEnv?: string;
  apiKeyStdin?: boolean;
  model?: string[];
}

interface OpenRouterConfiguredItem {
  name: string;
  providerType: string;
  auth: string;
  available: string;
  models: string;
}

interface OpenRouterDependencies {
  connectDaemon: (options: {
    host?: string;
  }) => Promise<Pick<DaemonClient, "getLastServerInfoMessage" | "setPaseoAgentProvider" | "close">>;
  env: NodeJS.ProcessEnv;
  readStdin: () => Promise<string>;
}

const DEFAULT_API_KEY_ENV = "OPENROUTER_API_KEY";

const defaultDependencies: OpenRouterDependencies = {
  connectDaemon: connectToDaemon,
  env: process.env,
  readStdin,
};

export const openRouterConfiguredSchema: OutputSchema<OpenRouterConfiguredItem> = {
  idField: "name",
  columns: [
    { header: "NAME", field: "name", width: 20 },
    { header: "TYPE", field: "providerType", width: 12 },
    { header: "AUTH", field: "auth", width: 16 },
    { header: "AVAILABLE", field: "available", width: 10 },
    { header: "MODELS", field: "models", width: 50 },
  ],
};

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk;
  }
  return value;
}

function normalizeModels(rawModels: string[] | undefined): string[] {
  return (rawModels ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

async function resolveApiKey(
  options: OpenRouterAddOptions,
  dependencies: OpenRouterDependencies,
): Promise<string> {
  if (options.apiKey) {
    return options.apiKey;
  }

  if (options.apiKeyStdin) {
    const value = (await dependencies.readStdin()).trim();
    if (value) {
      return value;
    }
    throw {
      code: "MISSING_API_KEY",
      message: "No OpenRouter API key was read from stdin",
    };
  }

  const envName = options.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  const value = dependencies.env[envName]?.trim();
  if (value) {
    return value;
  }

  throw {
    code: "MISSING_API_KEY",
    message: `OpenRouter API key not found in $${envName}`,
    details:
      "Set OPENROUTER_API_KEY, pass --api-key-env <name>, or pipe the key with --api-key-stdin.",
  };
}

function toConfiguredItem(provider: RedactedPaseoAgentProviderConfig): OpenRouterConfiguredItem {
  return {
    name: provider.name,
    providerType: provider.providerType,
    auth: provider.auth.configured ? (provider.auth.source ?? "configured") : "not configured",
    available: provider.available ? "yes" : "no",
    models: provider.models.map((model) => model.id).join(", "),
  };
}

function requirePaseoAgentConfigFeature(client: Pick<DaemonClient, "getLastServerInfoMessage">) {
  if (client.getLastServerInfoMessage()?.features?.paseoAgentConfig === true) {
    return;
  }
  throw {
    code: "HOST_UPDATE_REQUIRED",
    message: "Update the host to configure Paseo Agent providers.",
  };
}

export async function runAddOpenRouterCommand(
  name: string,
  options: OpenRouterAddOptions,
  _command: Command,
  dependencies: Partial<OpenRouterDependencies> = {},
): Promise<SingleResult<OpenRouterConfiguredItem>> {
  const deps = { ...defaultDependencies, ...dependencies };
  const models = normalizeModels(options.model);
  if (models.length === 0) {
    throw {
      code: "MISSING_MODELS",
      message: "At least one OpenRouter model is required",
      details: "Pass --model <provider/model-id>. Repeat --model to configure more than one.",
    };
  }

  const apiKey = await resolveApiKey(options, deps);
  const client = await deps.connectDaemon({ host: options.host });
  try {
    requirePaseoAgentConfigFeature(client);
    const result = await client.setPaseoAgentProvider({
      name,
      providerType: "openrouter",
      options: {
        apiKey,
        models: models.map((id) => ({ id })),
      },
    });
    if (!result.success || !result.provider) {
      throw {
        code: "PROVIDER_CONFIG_FAILED",
        message: result.error ?? "Daemon rejected the OpenRouter provider config",
      };
    }

    return {
      type: "single",
      data: toConfiguredItem(result.provider),
      schema: openRouterConfiguredSchema,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

export function addOpenRouterOptions(command: Command): Command {
  return command
    .description("Configure an OpenRouter inference provider for Paseo Agent")
    .argument("<name>", "Provider instance name")
    .option(
      "--model <id>",
      "OpenRouter model ID to expose (repeatable, comma-separated also accepted)",
      collectMultiple,
      [],
    )
    .option(
      "--api-key-env <name>",
      `Environment variable containing the API key`,
      DEFAULT_API_KEY_ENV,
    )
    .option("--api-key-stdin", "Read the API key from stdin")
    .option("--api-key <key>", "OpenRouter API key (prefer env or stdin to avoid shell history)");
}
