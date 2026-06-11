import { z } from "zod";

const ToolPermissionActionSchema = z.enum(["allow", "deny"]);

export const ToolPermissionRuleSchema = z
  .object({
    tool: z.string().min(1),
    action: ToolPermissionActionSchema,
  })
  .strict();

export type ToolPermissionAction = z.infer<typeof ToolPermissionActionSchema>;
export type ToolPermissionRule = z.infer<typeof ToolPermissionRuleSchema>;

export interface ToolPermissionPolicy {
  rules: ToolPermissionRule[];
}

export function createToolPermissionPolicy(
  rules: ToolPermissionRule[] | undefined,
): ToolPermissionPolicy {
  return { rules: rules ?? [] };
}

export function evaluateToolPermission(
  policy: ToolPermissionPolicy | undefined,
  toolName: string,
): ToolPermissionAction {
  for (const rule of policy?.rules ?? []) {
    if (matchesToolPattern(rule.tool, toolName)) {
      return rule.action;
    }
  }
  return "allow";
}

function matchesToolPattern(pattern: string, toolName: string): boolean {
  if (pattern === toolName || pattern === "*") {
    return true;
  }
  const matcher = new RegExp(`^${wildcardPatternToRegExp(pattern)}$`);
  return matcher.test(toolName);
}

function wildcardPatternToRegExp(pattern: string): string {
  return pattern.split("*").map(escapeRegExp).join(".*");
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
