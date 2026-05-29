import { describe, expect, it } from "vitest";

import {
  isRefreshTokenExpressionConfigured,
  resolveRefreshTokenExpression,
} from "./oauth-credentials.js";

describe("resolveRefreshTokenExpression", () => {
  it("returns a literal value", () => {
    expect(resolveRefreshTokenExpression("rt-literal", {})).toBe("rt-literal");
  });

  it("resolves an env reference and returns undefined when unset", () => {
    expect(resolveRefreshTokenExpression("$CODEX_RT", { CODEX_RT: "rt-env" })).toBe("rt-env");
    expect(resolveRefreshTokenExpression("${CODEX_RT}", { CODEX_RT: "rt-env" })).toBe("rt-env");
    expect(resolveRefreshTokenExpression("$CODEX_RT", {})).toBeUndefined();
  });

  it("runs a !command and returns its trimmed output", () => {
    expect(resolveRefreshTokenExpression("!printf rt-cmd", {})).toBe("rt-cmd");
    expect(resolveRefreshTokenExpression("!exit 1", {})).toBeUndefined();
  });
});

describe("isRefreshTokenExpressionConfigured", () => {
  it("is true for a literal and a set env var, false for an unset env var", () => {
    expect(isRefreshTokenExpressionConfigured("rt", {})).toBe(true);
    expect(isRefreshTokenExpressionConfigured("$RT", { RT: "x" })).toBe(true);
    expect(isRefreshTokenExpressionConfigured("$RT", {})).toBe(false);
  });

  it("assumes a !command is runnable without executing it", () => {
    expect(isRefreshTokenExpressionConfigured("!exit 1", {})).toBe(true);
  });
});
