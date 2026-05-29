import { execSync } from "node:child_process";

// Resolution of a *self-supplied* OAuth refresh token expression — a literal, an env
// reference (`$VAR` / `${VAR}`), or a `!command` that prints the token. This is an
// advanced/manual escape hatch for users who already hold their own ChatGPT/Codex
// refresh token; the product path is `paseo login chatgpt`, which performs browser
// OAuth by default and writes a Paseo-owned credential store (see oauth-store.ts).
//
// This module deliberately does NOT read any other tool's auth files (Codex CLI,
// OpenCode, Pi, etc.) and imports no Pi runtime code. Token values are never logged.

const ENV_REFERENCE_PATTERN = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;
const ENV_REFERENCE_DETECT = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/;

/** Substitute `$VAR` / `${VAR}` references. Returns undefined if any var is unset. */
function substituteEnv(value: string, env: NodeJS.ProcessEnv): string | undefined {
  let missing = false;
  const result = value.replace(ENV_REFERENCE_PATTERN, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) {
      missing = true;
      return "";
    }
    return resolved;
  });
  return missing ? undefined : result;
}

/**
 * Resolve a refresh-token expression to its literal value (may run a `!command`).
 * Returns undefined when it can't be resolved.
 */
export function resolveRefreshTokenExpression(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (value.startsWith("!")) {
    const command = value.slice(1).trim();
    if (!command) {
      return undefined;
    }
    try {
      const output = execSync(command, { encoding: "utf8", env }).trim();
      return output.length > 0 ? output : undefined;
    } catch {
      return undefined;
    }
  }
  if (ENV_REFERENCE_DETECT.test(value)) {
    const substituted = substituteEnv(value, env);
    return substituted && substituted.length > 0 ? substituted : undefined;
  }
  return value.length > 0 ? value : undefined;
}

/**
 * Cheap check: could this refresh-token expression yield a value without running a
 * command? `!command` is assumed runnable; env refs require their vars to be set.
 */
export function isRefreshTokenExpressionConfigured(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (value.startsWith("!")) {
    return true;
  }
  if (ENV_REFERENCE_DETECT.test(value)) {
    return substituteEnv(value, env) !== undefined;
  }
  return value.length > 0;
}
