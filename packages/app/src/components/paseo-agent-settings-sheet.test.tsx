/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RedactedPaseoAgentProviderConfig } from "@getpaseo/protocol/messages";

const { theme, hookState, setProviderMock } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
    fontSize: { xs: 11, sm: 13 },
    fontWeight: { medium: "500" },
    borderRadius: { lg: 8 },
    colors: {
      surface1: "#111",
      surface2: "#222",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      destructive: "#f00",
      statusSuccess: "#0f0",
    },
  },
  hookState: {
    supported: true,
    providers: [] as RedactedPaseoAgentProviderConfig[],
    isLoading: false,
    error: null as string | null,
  },
  setProviderMock: vi.fn(async () => null),
}));

vi.mock("react-native", () => ({
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
}));

vi.mock("lucide-react-native", () => ({
  Plus: () => React.createElement("span", { "data-icon": "Plus" }),
}));

vi.mock("@/constants/platform", () => ({ isWeb: true }));

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    children,
    footer,
    visible,
    testID,
  }: {
    children?: React.ReactNode;
    footer?: React.ReactNode;
    visible?: boolean;
    testID?: string;
  }) => (visible ? React.createElement("div", { "data-testid": testID }, children, footer) : null),
  AdaptiveTextInput: ({
    onChangeText,
    accessibilityLabel,
    testID,
  }: {
    onChangeText?: (value: string) => void;
    accessibilityLabel?: string;
    testID?: string;
  }) =>
    React.createElement("input", {
      "data-testid": testID,
      "aria-label": accessibilityLabel,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText?.(event.target.value),
    }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
    testID,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        "data-testid": testID,
        disabled,
        onClick: disabled ? undefined : onPress,
      },
      children,
    ),
}));

vi.mock("@/hooks/use-paseo-agent-providers", () => ({
  usePaseoAgentProviders: () => ({
    supported: hookState.supported,
    providers: hookState.providers,
    defaultModel: null,
    isLoading: hookState.isLoading,
    error: hookState.error,
    refresh: vi.fn(async () => {}),
    setProvider: setProviderMock,
  }),
}));

import { PaseoAgentSettingsSheet } from "./paseo-agent-settings-sheet";

function openRouterProvider(): RedactedPaseoAgentProviderConfig {
  return {
    name: "openrouter-main",
    providerType: "openrouter",
    models: [{ id: "anthropic/claude-3.7-sonnet" }],
    auth: { kind: "api_key", configured: true, source: "literal" },
    available: true,
    error: null,
  };
}

describe("PaseoAgentSettingsSheet", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    hookState.supported = true;
    hookState.providers = [];
    hookState.isLoading = false;
    hookState.error = null;
    setProviderMock.mockReset();
    setProviderMock.mockResolvedValue(null);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
  });

  function render(): void {
    act(() => {
      root?.render(<PaseoAgentSettingsSheet serverId="server-1" visible onClose={vi.fn()} />);
    });
  }

  function type(testID: string, value: string): void {
    const input = container?.querySelector<HTMLInputElement>(`[data-testid="${testID}"]`);
    if (!input) throw new Error(`No input ${testID}`);
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    act(() => {
      setValue?.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  }

  function click(testID: string): void {
    const el = container?.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
    if (!el) throw new Error(`No element ${testID}`);
    act(() => {
      el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
  }

  it("shows the update-host message and hides the add button when unsupported", () => {
    hookState.supported = false;
    render();

    expect(
      container?.querySelector('[data-testid="paseo-agent-unsupported"]')?.textContent,
    ).toContain("Update the host to configure Paseo Agent.");
    expect(container?.querySelector('[data-testid="paseo-agent-add-openrouter"]')).toBeNull();
  });

  it("shows the error message instead of the empty state when the fetch fails", () => {
    hookState.error = "Host is not connected";
    render();

    const text = container?.textContent ?? "";
    expect(text).toContain("Host is not connected");
    expect(text).not.toContain("No inference providers configured yet.");
  });

  it("lists configured providers with type, model count, and auth state", () => {
    hookState.providers = [openRouterProvider()];
    render();

    const text = container?.textContent ?? "";
    expect(text).toContain("openrouter-main");
    expect(text).toContain("openrouter");
    expect(text).toContain("1 model");
    expect(text).toContain("API key configured");
  });

  it("submits OpenRouter setup with name, api key, and parsed models", async () => {
    render();

    click("paseo-agent-add-openrouter");
    type("paseo-openrouter-name", "my-router");
    type("paseo-openrouter-api-key", "sk-or-secret");
    type("paseo-openrouter-models", "anthropic/claude-3.7-sonnet, openai/gpt-4o");

    await act(async () => {
      click("paseo-openrouter-submit");
    });

    expect(setProviderMock).toHaveBeenCalledTimes(1);
    expect(setProviderMock).toHaveBeenCalledWith({
      name: "my-router",
      providerType: "openrouter",
      options: {
        apiKey: "sk-or-secret",
        models: [{ id: "anthropic/claude-3.7-sonnet" }, { id: "openai/gpt-4o" }],
      },
    });
  });

  it("omits api key from the payload when left blank", async () => {
    render();

    click("paseo-agent-add-openrouter");
    type("paseo-openrouter-models", "anthropic/claude-3.7-sonnet");

    await act(async () => {
      click("paseo-openrouter-submit");
    });

    expect(setProviderMock).toHaveBeenCalledWith({
      name: "openrouter",
      providerType: "openrouter",
      options: {
        models: [{ id: "anthropic/claude-3.7-sonnet" }],
      },
    });
  });
});
