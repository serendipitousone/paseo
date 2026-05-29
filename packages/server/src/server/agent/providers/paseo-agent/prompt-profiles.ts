import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024;
const INLINE_INCLUDE_PATTERN = /\{\{\s*include:\s*([^}]+?)\s*\}\}/g;

const PromptProfileFrontmatterSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    mode: z.enum(["extend", "override"]).default("extend"),
    include: z.array(z.string().min(1)).optional(),
    mcp: z.array(z.string().min(1)).optional(),
    model: z.string().min(1).optional(),
    // Parsed for the future explicit project-context model. It is intentionally
    // inactive here; Paseo Agent still keeps implicit AGENTS.md discovery off.
    projectContext: z.boolean().optional(),
  })
  .strict();

export type PromptProfileFrontmatter = z.infer<typeof PromptProfileFrontmatterSchema>;

export interface PaseoComposedPrompt {
  customPrompt?: string;
  appendSystemPrompt: string[];
}

export interface ResolvedPromptProfile {
  id: string;
  path: string;
  frontmatter: PromptProfileFrontmatter;
  body: string;
  composedPrompt: PaseoComposedPrompt;
  expectedMcpServers: string[];
  model?: string;
}

interface LoadPromptProfileOptions {
  maxDepth?: number;
  maxTotalBytes?: number;
}

interface LoadState {
  totalBytes: number;
}

interface ParsedMarkdown {
  frontmatter: PromptProfileFrontmatter;
  body: string;
}

export function loadPromptProfile(
  paseoHome: string,
  profileName: string | undefined,
  options: LoadPromptProfileOptions = {},
): ResolvedPromptProfile | null {
  if (!profileName) {
    return null;
  }

  const agentsDir = resolve(paseoHome, "agents");
  const profilePath = resolveProfilePath(agentsDir, profileName);
  if (!existsSync(profilePath)) {
    return null;
  }

  const state: LoadState = { totalBytes: 0 };
  const parsed = loadMarkdownWithIncludes({
    agentsDir,
    path: profilePath,
    depth: 0,
    stack: [],
    state,
    options,
  });
  const body = trimPrompt(parsed.body);
  const mode = parsed.frontmatter.mode;
  const composedPrompt =
    mode === "override"
      ? { customPrompt: body, appendSystemPrompt: [] }
      : { appendSystemPrompt: body ? [body] : [] };

  return {
    id: basename(profilePath, ".md"),
    path: profilePath,
    frontmatter: parsed.frontmatter,
    body,
    composedPrompt,
    expectedMcpServers: parsed.frontmatter.mcp ?? [],
    ...(parsed.frontmatter.model ? { model: parsed.frontmatter.model } : {}),
  };
}

export function listPromptProfileIds(paseoHome: string): string[] {
  const agentsDir = resolve(paseoHome, "agents");
  if (!existsSync(agentsDir)) {
    return [];
  }
  return readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name) === ".md")
    .map((entry) => basename(entry.name, ".md"))
    .sort();
}

function resolveProfilePath(agentsDir: string, profileName: string): string {
  if (!isSafeRelativePath(profileName) || profileName.includes("/") || profileName.includes("\\")) {
    throw new Error(`Invalid Paseo Agent prompt profile path: ${profileName}`);
  }
  const filename = profileName.endsWith(".md") ? profileName : `${profileName}.md`;
  return resolveConfinedPath(agentsDir, filename);
}

function resolveIncludePath(agentsDir: string, includePath: string): string {
  if (!isSafeRelativePath(includePath)) {
    throw new Error(`Invalid Paseo Agent prompt include path: ${includePath}`);
  }
  return resolveConfinedPath(agentsDir, includePath);
}

function isSafeRelativePath(input: string): boolean {
  return input.trim() === input && input.length > 0 && !isAbsolute(input) && !input.includes("\0");
}

function resolveConfinedPath(agentsDir: string, input: string): string {
  const resolved = resolve(agentsDir, input);
  const rel = relative(agentsDir, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Paseo Agent prompt path escapes agents directory: ${input}`);
  }
  return resolved;
}

function loadMarkdownWithIncludes(input: {
  agentsDir: string;
  path: string;
  depth: number;
  stack: string[];
  state: LoadState;
  options: LoadPromptProfileOptions;
}): ParsedMarkdown {
  const maxDepth = input.options.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (input.depth > maxDepth) {
    throw new Error(`Paseo Agent prompt include depth exceeds ${maxDepth}`);
  }
  if (!existsSync(input.path) || !statSync(input.path).isFile()) {
    throw new Error(
      `Paseo Agent prompt include not found: ${relative(input.agentsDir, input.path)}`,
    );
  }

  const path = realpathConfined(input.agentsDir, input.path);
  if (input.stack.includes(path)) {
    const cycle = [...input.stack, path].map((entry) => relative(input.agentsDir, entry));
    throw new Error(`Paseo Agent prompt include cycle: ${cycle.join(" -> ")}`);
  }

  const raw = readFileSync(path, "utf8");
  input.state.totalBytes += Buffer.byteLength(raw, "utf8");
  const maxTotalBytes = input.options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  if (input.state.totalBytes > maxTotalBytes) {
    throw new Error(`Paseo Agent prompt profile exceeds ${maxTotalBytes} bytes`);
  }

  const parsed = parseMarkdown(raw);
  const stack = [...input.stack, path];
  const frontmatterIncludes = parsed.frontmatter.include ?? [];
  const prepended = frontmatterIncludes.map(
    (includePath) =>
      loadMarkdownWithIncludes({
        ...input,
        path: resolveIncludePath(input.agentsDir, includePath),
        depth: input.depth + 1,
        stack,
      }).body,
  );
  const bodyWithInlineIncludes = parsed.body.replace(
    INLINE_INCLUDE_PATTERN,
    (_match, includePath: string) =>
      loadMarkdownWithIncludes({
        ...input,
        path: resolveIncludePath(input.agentsDir, includePath.trim()),
        depth: input.depth + 1,
        stack,
      }).body,
  );

  return {
    frontmatter: parsed.frontmatter,
    body: joinPromptParts([...prepended, bodyWithInlineIncludes]),
  };
}

function realpathConfined(agentsDir: string, path: string): string {
  const realAgentsDir = realpathSync(agentsDir);
  const realPath = realpathSync(path);
  const rel = relative(realAgentsDir, realPath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Paseo Agent prompt path escapes agents directory: ${relative(agentsDir, path)}`,
    );
  }
  return realPath;
}

function parseMarkdown(raw: string): ParsedMarkdown {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    return {
      frontmatter: PromptProfileFrontmatterSchema.parse({}),
      body: raw,
    };
  }

  const newline = raw.startsWith("---\r\n") ? "\r\n" : "\n";
  const closeMarker = `${newline}---${newline}`;
  const closeIndex = raw.indexOf(closeMarker, 4);
  if (closeIndex === -1) {
    throw new Error("Paseo Agent prompt profile has unterminated frontmatter");
  }

  const yaml = raw.slice(4, closeIndex);
  const body = raw.slice(closeIndex + closeMarker.length);
  const value = yaml.trim() ? parseYaml(yaml) : {};
  return {
    frontmatter: PromptProfileFrontmatterSchema.parse(value ?? {}),
    body,
  };
}

export function composePromptParts(input: {
  profile?: ResolvedPromptProfile | null;
  systemPrompt?: string;
  daemonAppendSystemPrompt?: string;
}): PaseoComposedPrompt | undefined {
  const profilePrompt = input.profile?.composedPrompt;
  const appendSystemPrompt = [
    ...(profilePrompt?.appendSystemPrompt ?? []),
    input.systemPrompt,
    input.daemonAppendSystemPrompt,
  ].flatMap((part) => {
    const trimmed = trimPrompt(part);
    return trimmed ? [trimmed] : [];
  });
  const hasCustomPrompt = Boolean(
    profilePrompt && Object.prototype.hasOwnProperty.call(profilePrompt, "customPrompt"),
  );
  const customPrompt = trimPrompt(profilePrompt?.customPrompt);

  if (!hasCustomPrompt && appendSystemPrompt.length === 0) {
    return undefined;
  }

  return {
    ...(hasCustomPrompt ? { customPrompt } : {}),
    appendSystemPrompt,
  };
}

function trimPrompt(value: string | undefined): string {
  return value?.trim() ?? "";
}

function joinPromptParts(parts: string[]): string {
  return parts.map(trimPrompt).filter(Boolean).join("\n\n");
}
