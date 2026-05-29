import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { composePromptParts, listPromptProfileIds, loadPromptProfile } from "./prompt-profiles.js";

describe("Paseo Agent prompt profiles", () => {
  let paseoHome: string;
  let agentsDir: string;
  const tempDirs: string[] = [];

  beforeEach(() => {
    paseoHome = mkdtempSync(join(tmpdir(), "paseo-agent-profiles-"));
    agentsDir = join(paseoHome, "agents");
    mkdirSync(join(agentsDir, "fragments"), { recursive: true });
  });

  afterEach(() => {
    rmSync(paseoHome, { recursive: true, force: true });
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeProfile(name: string, content: string): void {
    writeFileSync(join(agentsDir, name), content);
  }

  it("parses frontmatter and lists only top-level markdown profiles", () => {
    writeProfile(
      "orchestrator.md",
      `---
name: Orchestrator
description: Routes work
mode: override
mcp: [paseo]
model: openrouter-main/test-model
projectContext: true
---
Profile body.
`,
    );
    writeProfile("notes.txt", "ignored");
    writeFileSync(join(agentsDir, "fragments", "piece.md"), "fragment");

    const profile = loadPromptProfile(paseoHome, "orchestrator");

    expect(listPromptProfileIds(paseoHome)).toEqual(["orchestrator"]);
    expect(profile?.frontmatter).toMatchObject({
      name: "Orchestrator",
      description: "Routes work",
      mode: "override",
      mcp: ["paseo"],
      model: "openrouter-main/test-model",
      projectContext: true,
    });
    expect(profile?.composedPrompt.customPrompt).toBe("Profile body.");
  });

  it("defaults to extend mode and prepends frontmatter includes in order", () => {
    writeFileSync(join(agentsDir, "fragments", "a.md"), "Fragment A");
    writeFileSync(join(agentsDir, "fragments", "b.md"), "Fragment B");
    writeProfile(
      "worker.md",
      `---
include:
  - fragments/a.md
  - fragments/b.md
---
Body.
`,
    );

    const profile = loadPromptProfile(paseoHome, "worker.md");

    expect(profile?.frontmatter.mode).toBe("extend");
    expect(profile?.body).toBe("Fragment A\n\nFragment B\n\nBody.");
    expect(profile?.composedPrompt.appendSystemPrompt).toEqual([
      "Fragment A\n\nFragment B\n\nBody.",
    ]);
  });

  it("resolves inline includes in place", () => {
    writeFileSync(join(agentsDir, "fragments", "style.md"), "Use short answers.");
    writeProfile("inline.md", "Before\n{{include: fragments/style.md}}\nAfter");

    expect(loadPromptProfile(paseoHome, "inline")?.body).toBe("Before\nUse short answers.\nAfter");
  });

  it("detects include cycles", () => {
    writeFileSync(join(agentsDir, "fragments", "a.md"), "{{include: fragments/b.md}}");
    writeFileSync(join(agentsDir, "fragments", "b.md"), "{{include: fragments/a.md}}");
    writeProfile("cycle.md", "{{include: fragments/a.md}}");

    expect(() => loadPromptProfile(paseoHome, "cycle")).toThrow(/cycle/i);
  });

  it("rejects missing fragments and path escapes", () => {
    writeProfile("missing.md", "{{include: fragments/nope.md}}");
    writeProfile("escape.md", "{{include: ../secret.md}}");

    expect(() => loadPromptProfile(paseoHome, "missing")).toThrow(/not found/i);
    expect(() => loadPromptProfile(paseoHome, "escape")).toThrow(/escape|invalid/i);
    expect(() => loadPromptProfile(paseoHome, "../escape")).toThrow(/invalid/i);
  });

  it("rejects symlink escapes for profiles and includes", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "paseo-agent-profile-outside-"));
    tempDirs.push(outsideDir);
    writeFileSync(join(outsideDir, "secret.md"), "outside secret");
    symlinkSync(join(outsideDir, "secret.md"), join(agentsDir, "linked-profile.md"));
    symlinkSync(join(outsideDir, "secret.md"), join(agentsDir, "fragments", "linked.md"));
    writeProfile("include-link.md", "{{include: fragments/linked.md}}");

    expect(() => loadPromptProfile(paseoHome, "linked-profile")).toThrow(/escapes/i);
    expect(() => loadPromptProfile(paseoHome, "include-link")).toThrow(/escapes/i);
  });

  it("enforces depth and total size caps", () => {
    writeFileSync(join(agentsDir, "fragments", "deep.md"), "{{include: fragments/deeper.md}}");
    writeFileSync(join(agentsDir, "fragments", "deeper.md"), "done");
    writeProfile("depth.md", "{{include: fragments/deep.md}}");
    writeProfile("large.md", "0123456789");

    expect(() => loadPromptProfile(paseoHome, "depth", { maxDepth: 1 })).toThrow(/depth/i);
    expect(() => loadPromptProfile(paseoHome, "large", { maxTotalBytes: 4 })).toThrow(/bytes/i);
  });

  it("orders profile append, session prompt, and daemon append with daemon last", () => {
    writeProfile("extend.md", "Profile prompt.");
    const profile = loadPromptProfile(paseoHome, "extend");

    expect(
      composePromptParts({
        profile,
        systemPrompt: "  Agent prompt.  ",
        daemonAppendSystemPrompt: "Daemon prompt.",
      }),
    ).toEqual({
      appendSystemPrompt: ["Profile prompt.", "Agent prompt.", "Daemon prompt."],
    });
  });

  it("uses override profile body as custom prompt while appending session and daemon prompts", () => {
    writeProfile(
      "override.md",
      `---
mode: override
---
Replacement base.
`,
    );
    const profile = loadPromptProfile(paseoHome, "override");

    expect(
      composePromptParts({
        profile,
        systemPrompt: "Agent prompt.",
        daemonAppendSystemPrompt: "Daemon prompt.",
      }),
    ).toEqual({
      customPrompt: "Replacement base.",
      appendSystemPrompt: ["Agent prompt.", "Daemon prompt."],
    });
  });
});
