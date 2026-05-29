import type { DaemonClient as InternalDaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { gotoAppShell, openSettings } from "./app";
import { connectDaemonClient } from "./daemon-client-loader";
import { getServerId } from "./server-id";
import { openSettingsHost } from "./settings";

type PaseoAgentDaemonClient = Pick<
  InternalDaemonClient,
  | "close"
  | "connect"
  | "removePaseoAgentProvider"
  | "setPaseoAgentProvider"
  | "storePaseoAgentChatGptCredential"
>;

interface OpenRouterProviderInput {
  name: string;
  apiKey: string;
  models: string[];
}

interface ExpectedProvider {
  name: string;
  providerType: "openai-codex" | "openrouter";
  auth: "API key configured" | "ChatGPT login stored";
  modelCount: number;
}

async function connectPaseoAgentClient(): Promise<PaseoAgentDaemonClient> {
  return connectDaemonClient<PaseoAgentDaemonClient>({ clientIdPrefix: "paseo-agent-e2e" });
}

export async function openPaseoAgentSettings(page: Page): Promise<void> {
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHost(page, getServerId());
  await page.getByRole("button", { name: "Paseo Agent provider details", exact: true }).click();
  const sheet = page.getByTestId("paseo-agent-settings-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Paseo Agent", { exact: true })).toBeVisible();
}

export async function addOpenRouterProvider(
  page: Page,
  provider: OpenRouterProviderInput,
): Promise<void> {
  await page.getByRole("button", { name: "Add OpenRouter", exact: true }).click();
  await expect(page.getByText("Add OpenRouter provider", { exact: true })).toBeVisible();

  await page.getByLabel("Provider name").fill(provider.name);
  await page.getByLabel("OpenRouter API key").fill(provider.apiKey);
  await page.getByLabel("OpenRouter models").fill(provider.models.join("\n"));
  await page.getByRole("button", { name: "Save provider", exact: true }).click();

  await expect(page.getByText("Add OpenRouter provider", { exact: true })).toHaveCount(0);
  await expect(page.getByText(provider.apiKey, { exact: true })).toHaveCount(0);
}

export async function expectInferenceProviderListed(
  page: Page,
  expected: ExpectedProvider,
): Promise<void> {
  const modelLabel = expected.modelCount === 1 ? "1 model" : `${expected.modelCount} models`;
  await expect(
    page.getByRole("listitem", {
      name: new RegExp(
        `${expected.name}.*${expected.providerType}.*${modelLabel}.*${expected.auth}`,
      ),
    }),
  ).toBeVisible();
}

export async function seedChatGptProvider(providerName: string): Promise<void> {
  const client = await connectPaseoAgentClient();
  try {
    await client.setPaseoAgentProvider({
      name: providerName,
      providerType: "openai-codex",
      options: {
        models: [{ id: "gpt-5.3-codex", reasoning: true }],
      },
    });
    await client.storePaseoAgentChatGptCredential({
      providerName,
      credential: {
        type: "oauth",
        access: "fake-access-token",
        refresh: "fake-refresh-token",
        expires: 4_102_444_800,
        futureField: { passthrough: true },
      },
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function cleanupPaseoAgentProviders(providerNames: Iterable<string>): Promise<void> {
  const client = await connectPaseoAgentClient();
  try {
    for (const name of providerNames) {
      await client.removePaseoAgentProvider(name);
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}
