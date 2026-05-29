# Paseo Agent provider

Paseo Agent is a built-in provider that runs Pi's coding-agent harness **in process** (no `pi` CLI, no `~/.pi` discovery). It is configured entirely by Paseo-owned config under `agents.paseo` in `$PASEO_HOME/config.json`. The model backends are "inference providers": one or more typed entries, each pointing at an API with its own key and models.

The provider id is **`paseo`** (the display name is "Paseo Agent"). Use it like any other provider, e.g. `paseo run --provider paseo --model <inferenceProviderName>/<modelId> ...`.

This is a prototype. There is no app UI yet. OpenRouter and ChatGPT setup have CLI
paths; other provider setup is still config-file based.

> Smoke note: the daemon supervisor runs from `packages/server/dist`. After changing
> provider/config code, run `npm run build:server` (or run a source/dev daemon) before
> smoking, otherwise a stale `dist` may reject the `agents.paseo` config. Always pass
> `--host <addr>` to CLI smoke commands so they hit your isolated daemon, not the real
> daemon on `:6767`.

## MCP tools

Paseo Agent bridges `AgentSessionConfig.mcpServers` into Pi custom tools, so the
daemon-injected `paseo` MCP server (and any other configured MCP server) is available to
the model. On session start the provider connects to each server, lists its tools, and
registers them as Pi tools named `<serverName>__<toolName>`; tool input schemas (JSON
Schema) are converted to TypeBox, calls are proxied to the MCP server, and results map
back to the model. Connections are torn down on session close. Servers that fail to
connect or list are logged and skipped rather than failing the session.

Transports: HTTP (streamable) is the primary path (the injected `paseo` server is HTTP);
SSE and stdio transports are also wired via the MCP SDK. No extra config is needed — MCP
servers come from Paseo's normal injection/config, not from `agents.paseo`.

## Prompt profiles

Paseo Agent can load a Paseo-owned prompt profile from `$PASEO_HOME/agents/*.md`.
Configure the default profile in `agents.paseo.defaultProfile`; `orchestrator` resolves
to `$PASEO_HOME/agents/orchestrator.md`. Only top-level markdown files are profiles.
Reusable fragments live under `$PASEO_HOME/agents/fragments/*.md`.

```jsonc
{
  "agents": {
    "paseo": {
      "defaultProfile": "orchestrator",
      "defaultModel": "openrouter-main/anthropic/claude-3.7-sonnet",
      "providers": {},
    },
  },
}
```

Example `$PASEO_HOME/agents/orchestrator.md`:

```markdown
---
name: Orchestrator
description: Coordinates work through Paseo-managed agents
mode: extend
include:
  - fragments/collaboration.md
mcp: [paseo]
model: openrouter-main/anthropic/claude-3.7-sonnet
---

Use the Paseo MCP tools to inspect active agents, create focused helper agents, and
summarize handoffs clearly.

{{include: fragments/review-rules.md}}
```

`mode: extend` keeps Pi's default base prompt and prepends the composed profile body to
the append list. `mode: override` uses the profile body as the custom base prompt, so
Pi's default base prompt is skipped. In both modes, per-session `systemPrompt` is appended
after the profile, and the daemon-level append prompt is appended last.

Frontmatter supports `name`, `description`, `mode`, `include`, `mcp`, `model`, and
`projectContext`. `projectContext` is parsed for a future explicit project-context model,
but it does not activate implicit `AGENTS.md`/`CLAUDE.md` discovery; Paseo Agent still
keeps Pi context discovery off. `model` is only a lowest-precedence default: an explicit
session model wins, then `agents.paseo.defaultModel`, then the profile model.

Includes are deliberately confined to `$PASEO_HOME/agents`: absolute paths, `..` escapes,
cycles, overly deep include chains, and oversized profiles are rejected. Frontmatter
`include` entries are prepended in order; inline `{{include: fragments/foo.md}}` entries
are expanded in place.

`mcp: [paseo]` is an expectation check, not a new injection mechanism. The normal daemon
MCP injection still supplies the actual server; if a profile declares an MCP server that
is not present in the session's `mcpServers`, Paseo Agent logs a warning and continues.

## Config shape

```jsonc
{
  "agents": {
    "paseo": {
      // Optional. "<inferenceProviderName>/<modelId>". Used when an agent is
      // started without an explicit model.
      "defaultModel": "openrouter-main/anthropic/claude-3.7-sonnet",

      // Optional. Loads $PASEO_HOME/agents/orchestrator.md by default for new
      // Paseo Agent sessions.
      "defaultProfile": "orchestrator",

      // Inference providers, keyed by instance name. Names are free-form; you may
      // run several entries of the same type against different APIs/keys/models.
      "providers": {
        "openrouter-main": {
          "type": "openrouter",
          "options": {
            // apiKey may be omitted to fall back to the type's env var
            // (here OPENROUTER_API_KEY). It may also be a literal, an env
            // reference like "$OPENROUTER_API_KEY" / "${OPENROUTER_API_KEY}",
            // or a "!command" that prints the key.
            "models": [
              { "id": "anthropic/claude-3.7-sonnet", "label": "Claude 3.7", "reasoning": true },
              { "id": "openai/gpt-4o", "label": "GPT-4o" },
            ],
          },
        },
      },
    },
  },
}
```

## Supported types

Each type supplies sensible defaults so you usually only provide an API key (or its
env var) and model ids.

| type                | wire `api`                  | default base URL                  | default key env var   |
| ------------------- | --------------------------- | --------------------------------- | --------------------- |
| `openrouter`        | `openai-completions`        | `https://openrouter.ai/api/v1`    | `OPENROUTER_API_KEY`  |
| `openai`            | `openai-responses`          | `https://api.openai.com/v1`       | `OPENAI_API_KEY`      |
| `anthropic`         | `anthropic-messages`        | `https://api.anthropic.com`       | `ANTHROPIC_API_KEY`   |
| `opencode`          | `openai-completions`        | `https://opencode.ai/zen/v1`      | `OPENCODE_API_KEY`    |
| `openai-compatible` | `openai-completions`        | _(required: `options.baseUrl`)_   | _(none — set apiKey)_ |
| `openai-codex`      | `openai-codex-responses`    | `https://chatgpt.com/backend-api` | _(OAuth — see below)_ |
| `custom`            | _(required: `options.api`)_ | _(required: `options.baseUrl`)_   | _(none — set apiKey)_ |

Per-entry overrides live in `options`: `baseUrl`, `api`, `apiKey`, `headers`,
`authHeader` (send `Authorization: Bearer <apiKey>`), and `models[]`. Each model may
override `api` (e.g. an `anthropic-messages` model behind an otherwise
`openai-completions` provider), plus `label`, `reasoning`, `contextWindow`, `maxTokens`.

### OpenCode Zen / Go (OpenAI-compatible)

OpenCode Zen models speak either `openai-completions` or `anthropic-messages`. Use the
`opencode` type for Zen, or `openai-compatible` with an explicit base URL for Go, and
override the per-model `api` where a model is Anthropic-family:

```jsonc
{
  "type": "opencode",
  "options": {
    "models": [
      { "id": "big-pickle" },
      { "id": "claude-sonnet", "api": "anthropic-messages" }
    ]
  }
}
// OpenCode Go:
{
  "type": "openai-compatible",
  "options": {
    "baseUrl": "https://opencode.ai/zen/go/v1",
    "apiKey": "$OPENCODE_API_KEY",
    "models": [{ "id": "glm-5" }]
  }
}
```

Pi attaches its own `x-opencode-*` attribution headers automatically when the base URL
is on `opencode.ai`, so you do not set those yourself.

### `custom` escape hatch

When a backend needs a wire protocol the named types don't cover, use `custom` and set
`options.api` to a Pi wire protocol (e.g. `google-generative-ai`, `mistral-conversations`,
`openai-codex-responses`) plus `options.baseUrl`. This is a thin pass-through, not a place
to embed raw Pi internals.

## Authentication

- **API key / env var / command** — works for every type. Omit `apiKey` to use the
  type's default env var; or set a literal, a `$ENV` reference, or a `!command`.
- A provider only counts as "available" (and its models listable for use) when its
  resolved key is actually present — a literal value, a set env var, or a command.

### ChatGPT / OpenAI subscription (OAuth) — `openai-codex`

The `openai-codex` type uses a ChatGPT/OpenAI **subscription** via OAuth instead of an
API key, against `https://chatgpt.com/backend-api` with the `openai-codex-responses` wire
API. Paseo **owns** the auth: `paseo login chatgpt` runs Pi's browser PKCE/callback
OAuth flow by default, stores the credential in a Paseo-controlled file, and lets Pi
refresh/rotate it there. Paseo does **not** read ChatGPT/Codex/OpenCode/Pi or any other
tool's auth files.

Config — just declare the provider and its models (no credential field):

```jsonc
{
  "agents": {
    "paseo": {
      "providers": {
        "chatgpt": {
          "type": "openai-codex",
          "options": { "models": [{ "id": "gpt-5.3-codex", "reasoning": true }] },
        },
      },
    },
  },
}
```

> Use a model id that ChatGPT-account Codex supports — e.g. `gpt-5.3-codex` (live-verified),
> or another Pi codex id like `gpt-5.2`, `gpt-5.4`, `gpt-5.4-mini`. The non-subscription id
> `gpt-5-codex` is **not** accepted on a ChatGPT account (the backend returns a 400
> "model is not supported when using Codex with a ChatGPT account").

Then log in once (the credential is stored under the `chatgpt` provider instance):

```bash
paseo login chatgpt
# Opens your browser to approve (OAuth PKCE + local callback on 127.0.0.1:1455).
# If the browser can't open, the URL is printed to copy; you can also paste the code.
```

Headless machines (no browser) can use the device-code fallback:

```bash
paseo login chatgpt --device-code   # prints a URL + code to enter on another device
```

Both store the credential at `$PASEO_HOME/paseo-agent/auth.json` (mode `0600`, created by
Pi's AuthStorage; pass `--home` to target a specific Paseo home). On each session the
provider loads that credential, and Pi refreshes expired access tokens — persisting any
rotated refresh token **back into Paseo's own file**. A codex provider counts as
"available" once a credential is stored. Token values are never logged or printed.

> **Rotation is handled within Paseo.** Because Paseo owns the store and Pi writes
> refreshed tokens back to it, rotation does not break Paseo. Run `paseo login chatgpt`
> again any time to re-authorize (e.g. after a long idle period or an explicit logout).

**Advanced / manual override (not the normal path).** If you already hold your own refresh
token you may set `options.refreshToken` to a literal, `"$ENV"`/`"${ENV}"`, or `"!command"`.
It is seeded into the Paseo store at session start. This is for power users/automation; the
normal path is `paseo login chatgpt`. Paseo still never reads another tool's auth files.

Other OAuth providers (Anthropic Pro/Max, Copilot) remain unwired; for those you can pass a
pre-obtained bearer token via `apiKey`/env where accepted (e.g. `ANTHROPIC_OAUTH_TOKEN`).

## CLI setup

Configure an OpenRouter provider through the selected daemon:

```bash
export OPENROUTER_API_KEY=...
paseo provider add openrouter openrouter-main \
  --model anthropic/claude-3.7-sonnet \
  --host localhost:7777
```

For shell-history-safe key entry, pipe the key instead:

```bash
printf '%s\n' "$OPENROUTER_API_KEY" |
  paseo provider add openrouter openrouter-main \
    --api-key-stdin \
    --model anthropic/claude-3.7-sonnet \
    --host localhost:7777
```

`paseo login chatgpt --host <host>` runs browser OAuth on the CLI machine, then sends
the returned credential to the selected daemon. The credential is stored in that daemon's
`$PASEO_HOME/paseo-agent/auth.json`; token values are not printed. `--device-code` is
currently local-only and is rejected when combined with `--host` until a daemon-run
device-code RPC exists.
