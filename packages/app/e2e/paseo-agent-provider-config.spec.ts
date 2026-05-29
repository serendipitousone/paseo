import { test } from "./fixtures";
import {
  addOpenRouterProvider,
  cleanupPaseoAgentProviders,
  expectInferenceProviderListed,
  openPaseoAgentSettings,
  seedChatGptProvider,
} from "./helpers/paseo-agent";

const OPENROUTER_PROVIDER = "phase-e-openrouter-ui";
const CHATGPT_PROVIDER = "phase-e-chatgpt-ui";

test.describe("Paseo Agent provider configuration", () => {
  const providerNamesToCleanup = new Set<string>();

  test.afterEach(async () => {
    await cleanupPaseoAgentProviders(providerNamesToCleanup);
    providerNamesToCleanup.clear();
  });

  test("adds an OpenRouter inference provider from Settings", async ({ page }) => {
    providerNamesToCleanup.add(OPENROUTER_PROVIDER);

    await openPaseoAgentSettings(page);
    await addOpenRouterProvider(page, {
      name: OPENROUTER_PROVIDER,
      apiKey: "sk-or-phase-e-write-only",
      models: ["openai/gpt-4o-mini", "anthropic/claude-3.7-sonnet"],
    });

    await expectInferenceProviderListed(page, {
      name: OPENROUTER_PROVIDER,
      providerType: "openrouter",
      modelCount: 2,
      auth: "API key configured",
    });
  });

  test("shows a stored ChatGPT login as a read-only inference provider row", async ({ page }) => {
    providerNamesToCleanup.add(CHATGPT_PROVIDER);

    await seedChatGptProvider(CHATGPT_PROVIDER);
    await openPaseoAgentSettings(page);

    await expectInferenceProviderListed(page, {
      name: CHATGPT_PROVIDER,
      providerType: "openai-codex",
      modelCount: 1,
      auth: "ChatGPT login stored",
    });
  });
});
