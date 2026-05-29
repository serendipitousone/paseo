import { Command } from "commander";
import { runLsCommand } from "./ls.js";
import { runModelsCommand } from "./models.js";
import { addOpenRouterOptions, runAddOpenRouterCommand } from "./openrouter.js";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";

export function createProviderCommand(
  dependencies: Parameters<typeof runAddOpenRouterCommand>[3] = {},
): Command {
  const provider = new Command("provider").description("Manage agent providers");

  addJsonAndDaemonHostOptions(
    provider.command("ls").description("List available providers and status"),
  ).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(
    provider
      .command("models")
      .description("List models for a provider")
      .argument("<provider>", "Provider name (claude, codex, opencode)")
      .option("--thinking", "Include thinking option IDs for each model"),
  ).action(withOutput(runModelsCommand));

  const add = provider.command("add").description("Configure a provider");
  addJsonAndDaemonHostOptions(addOpenRouterOptions(add.command("openrouter"))).action(
    withOutput<Awaited<ReturnType<typeof runAddOpenRouterCommand>>["data"], [string]>(
      (name, options, command) => runAddOpenRouterCommand(name, options, command, dependencies),
    ),
  );

  return provider;
}
