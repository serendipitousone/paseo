import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import {
  getAgentStreamEventTurnId,
  type AgentCapabilityFlags,
  type AgentClient,
  type AgentLaunchContext,
  type AgentMode,
  type AgentModelDefinition,
  type AgentPermissionRequest,
  type AgentPermissionResponse,
  type AgentPersistenceHandle,
  type AgentPromptInput,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentRuntimeInfo,
  type AgentSession,
  type AgentSessionConfig,
  type AgentSlashCommand,
  type AgentStreamEvent,
  type AgentTimelineItem,
  type AgentUsage,
  type ListModelsOptions,
} from "../../agent-sdk-types.js";
import {
  PASEO_AGENT_PROVIDER,
  type PaseoAgentConfig,
  listPaseoAgentModels,
  paseoAgentHasUsableModel,
  paseoAgentInferenceProviders,
  parsePaseoAgentModelId,
  resolvePaseoAgentModel,
} from "./config.js";
import {
  convertPromptInput,
  getUserMessageText,
  mapToolDetail,
  parseToolArgs,
  parseToolResult,
  toAgentUsage,
  type PiTrackedToolCall,
} from "./event-mapping.js";
import { createMcpToolBridge, type McpToolBridge } from "./mcp-bridge.js";
import { createPaseoAgentAuthStorage, hasStoredOAuthCredential } from "./oauth-store.js";
import { createPaseoAgentSession, type PaseoAgentSessionHandle } from "./pi-services.js";
import { composePromptParts, loadPromptProfile } from "./prompt-profiles.js";

const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

const PASEO_AGENT_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  // Phase 4 uses in-memory sessions; resume/persistence is out of scope.
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  // MCP servers from AgentSessionConfig.mcpServers are bridged to Pi custom tools.
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

const THINKING_LEVELS: ReadonlySet<ThinkingLevel> = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function normalizeThinkingLevel(value: string | null | undefined): ThinkingLevel | null {
  return value && THINKING_LEVELS.has(value as ThinkingLevel) ? (value as ThinkingLevel) : null;
}

function resolveIsolatedAgentDir(): string {
  // Paseo-owned, never ~/.pi. Inert because all Pi services are in-memory, but we
  // still keep it off the project tree and outside Pi's default global config.
  const base = process.env.PASEO_HOME ?? join(tmpdir(), "paseo-agent");
  return join(base, "pi-harness");
}

interface PaseoAgentClientOptions {
  logger: Logger;
  config: PaseoAgentConfig;
  paseoHome?: string;
}

export class PaseoAgentSession implements AgentSession {
  readonly provider = PASEO_AGENT_PROVIDER;
  readonly capabilities = PASEO_AGENT_CAPABILITIES;

  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly activeToolCalls = new Map<string, PiTrackedToolCall>();
  private activeTurnId: string | null = null;
  private lastThinkingOptionId: string | null;

  constructor(
    private readonly handle: PaseoAgentSessionHandle,
    private readonly config: AgentSessionConfig,
    private readonly mcpBridge: McpToolBridge,
  ) {
    this.lastThinkingOptionId =
      normalizeThinkingLevel(config.thinkingOptionId) ?? this.piSession.thinkingLevel ?? null;
    this.piSession.subscribe((event) => this.handleSessionEvent(event));
  }

  private get piSession() {
    return this.handle.session;
  }

  get id(): string | null {
    return this.piSession.sessionId;
  }

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  private emitToolCall(
    toolCallId: string,
    toolCall: PiTrackedToolCall,
    status: "running" | "completed" | "failed",
    result: ReturnType<typeof parseToolResult>,
    error: unknown,
  ): void {
    const turnId = this.activeTurnId ?? undefined;
    const baseItem = {
      type: "tool_call" as const,
      callId: toolCallId,
      name: toolCall.toolName,
      detail: mapToolDetail(toolCall, result),
    };
    const item =
      status === "failed" ? { ...baseItem, status, error } : { ...baseItem, status, error: null };
    this.emit({ type: "timeline", provider: PASEO_AGENT_PROVIDER, turnId, item });
  }

  private handleSessionEvent(event: AgentSessionEvent): void {
    const turnId = this.activeTurnId ?? undefined;
    switch (event.type) {
      case "agent_start":
        this.emit({
          type: "thread_started",
          provider: PASEO_AGENT_PROVIDER,
          sessionId: this.piSession.sessionId,
        });
        return;
      case "turn_start":
        this.emit({ type: "turn_started", provider: PASEO_AGENT_PROVIDER, turnId });
        return;
      case "message_update": {
        if (event.message.role !== "assistant") {
          return;
        }
        if (event.assistantMessageEvent.type === "text_delta") {
          this.emit({
            type: "timeline",
            provider: PASEO_AGENT_PROVIDER,
            turnId,
            item: { type: "assistant_message", text: event.assistantMessageEvent.delta ?? "" },
          });
          return;
        }
        if (event.assistantMessageEvent.type === "thinking_delta") {
          this.emit({
            type: "timeline",
            provider: PASEO_AGENT_PROVIDER,
            turnId,
            item: { type: "reasoning", text: event.assistantMessageEvent.delta ?? "" },
          });
        }
        return;
      }
      case "tool_execution_start": {
        const toolCall = parseToolArgs(event.toolName, event.args);
        this.activeToolCalls.set(event.toolCallId, toolCall);
        this.emitToolCall(event.toolCallId, toolCall, "running", null, null);
        return;
      }
      case "tool_execution_update": {
        const toolCall = this.activeToolCalls.get(event.toolCallId);
        if (!toolCall) {
          return;
        }
        this.emitToolCall(
          event.toolCallId,
          toolCall,
          "running",
          parseToolResult(event.partialResult),
          null,
        );
        return;
      }
      case "tool_execution_end": {
        const toolCall =
          this.activeToolCalls.get(event.toolCallId) ?? parseToolArgs(event.toolName, null);
        this.activeToolCalls.delete(event.toolCallId);
        const result = parseToolResult(event.result);
        const status = event.isError ? "failed" : "completed";
        this.emitToolCall(
          event.toolCallId,
          toolCall,
          status,
          result,
          event.isError ? event.result : null,
        );
        return;
      }
      case "agent_end": {
        const usage = toAgentUsage(this.piSession.getSessionStats());
        const currentTurnId = turnId;
        this.activeTurnId = null;
        const errorMessage = this.piSession.agent.state.errorMessage;
        if (errorMessage) {
          this.emit({
            type: "turn_failed",
            provider: PASEO_AGENT_PROVIDER,
            turnId: currentTurnId,
            error: errorMessage,
          });
          return;
        }
        this.emit({
          type: "turn_completed",
          provider: PASEO_AGENT_PROVIDER,
          turnId: currentTurnId,
          usage,
        });
        return;
      }
      default:
        return;
    }
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    const timeline: AgentTimelineItem[] = [];
    let finalText = "";
    let usage: AgentUsage | undefined;
    let turnId: string | null = null;
    const bufferedEvents: AgentStreamEvent[] = [];
    let settled = false;
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;

    function processEvent(event: AgentStreamEvent): void {
      if (settled) {
        return;
      }
      const eventTurnId = getAgentStreamEventTurnId(event);
      if (turnId && eventTurnId && eventTurnId !== turnId) {
        return;
      }
      if (event.type === "timeline") {
        timeline.push(event.item);
        if (event.item.type === "assistant_message") {
          finalText += event.item.text;
        }
        return;
      }
      if (event.type === "turn_completed") {
        usage = event.usage;
        settled = true;
        resolveCompletion();
        return;
      }
      if (event.type === "turn_failed") {
        settled = true;
        rejectCompletion(new Error(event.error));
      }
    }

    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const unsubscribe = this.subscribe((event) => {
      if (!turnId) {
        bufferedEvents.push(event);
        return;
      }
      processEvent(event);
    });

    try {
      const result = await this.startTurn(prompt, options);
      turnId = result.turnId;
      for (const event of bufferedEvents) {
        processEvent(event);
      }
      if (!settled) {
        await completion;
      }
    } finally {
      unsubscribe();
    }

    return { sessionId: this.piSession.sessionId, finalText, usage, timeline };
  }

  async startTurn(
    prompt: AgentPromptInput,
    _options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    if (this.activeTurnId) {
      throw new Error("A Paseo Agent turn is already active");
    }
    const payload = convertPromptInput(prompt);
    const turnId = randomUUID();
    this.activeTurnId = turnId;

    void this.piSession
      .prompt(payload.text, payload.images ? { images: payload.images } : undefined)
      .catch((error: unknown) => {
        const failedTurnId = this.activeTurnId ?? turnId;
        this.activeTurnId = null;
        this.emit({
          type: "turn_failed",
          provider: PASEO_AGENT_PROVIDER,
          turnId: failedTurnId,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    const pendingToolCalls = new Map<string, PiTrackedToolCall>();
    let userIndex = 0;

    for (const message of this.piSession.messages) {
      if (message.role === "user") {
        const text = getUserMessageText(message.content);
        if (text) {
          yield {
            type: "timeline",
            provider: PASEO_AGENT_PROVIDER,
            item: { type: "user_message", text, messageId: `paseo-agent-user-${userIndex}` },
          };
        }
        userIndex += 1;
        continue;
      }
      if (message.role === "assistant") {
        for (const content of message.content) {
          if (content.type === "text" && content.text) {
            yield {
              type: "timeline",
              provider: PASEO_AGENT_PROVIDER,
              item: { type: "assistant_message", text: content.text },
            };
            continue;
          }
          if (content.type === "thinking" && content.thinking) {
            yield {
              type: "timeline",
              provider: PASEO_AGENT_PROVIDER,
              item: { type: "reasoning", text: content.thinking },
            };
            continue;
          }
          if (content.type === "toolCall") {
            const tracked = parseToolArgs(content.name, content.arguments);
            pendingToolCalls.set(content.id, tracked);
            yield {
              type: "timeline",
              provider: PASEO_AGENT_PROVIDER,
              item: {
                type: "tool_call",
                callId: content.id,
                name: tracked.toolName,
                status: "running",
                detail: mapToolDetail(tracked, null),
                error: null,
              },
            };
          }
        }
        continue;
      }
      if (message.role === "toolResult") {
        const tracked =
          pendingToolCalls.get(message.toolCallId) ?? parseToolArgs(message.toolName, null);
        pendingToolCalls.delete(message.toolCallId);
        const detail = mapToolDetail(tracked, parseToolResult({ content: message.content }));
        const base = {
          type: "tool_call" as const,
          callId: message.toolCallId,
          name: tracked.toolName,
          detail,
        };
        yield {
          type: "timeline",
          provider: PASEO_AGENT_PROVIDER,
          item: message.isError
            ? { ...base, status: "failed", error: "Tool call failed" }
            : { ...base, status: "completed", error: null },
        };
      }
    }
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    const model = this.piSession.model;
    return {
      provider: PASEO_AGENT_PROVIDER,
      sessionId: this.piSession.sessionId,
      model: model ? `${model.provider}/${model.id}` : null,
      thinkingOptionId:
        normalizeThinkingLevel(this.lastThinkingOptionId) ?? this.piSession.thinkingLevel ?? null,
      modeId: null,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [];
  }

  async getCurrentMode(): Promise<string | null> {
    return null;
  }

  async setMode(_modeId: string): Promise<void> {
    throw new Error("Paseo Agent does not expose selectable modes");
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }

  async respondToPermission(
    _requestId: string,
    _response: AgentPermissionResponse,
  ): Promise<void> {}

  describePersistence(): AgentPersistenceHandle | null {
    return null;
  }

  async interrupt(): Promise<void> {
    await this.piSession.abort();
  }

  async close(): Promise<void> {
    this.piSession.dispose();
    await this.mcpBridge.close();
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    return [];
  }

  async setModel(modelId: string | null): Promise<void> {
    if (!modelId) {
      return;
    }
    const reference = parsePaseoAgentModelId(modelId);
    if (!reference) {
      throw new Error(`Invalid Paseo Agent model: ${modelId}`);
    }
    const model = this.handle.modelRegistry.find(reference.provider, reference.id);
    if (!model) {
      throw new Error(`Unknown Paseo Agent model: ${modelId}`);
    }
    await this.piSession.setModel(model);
    this.config.model = modelId;
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    const level = normalizeThinkingLevel(thinkingOptionId) ?? DEFAULT_THINKING_LEVEL;
    this.piSession.setThinkingLevel(level);
    this.lastThinkingOptionId = level;
    this.config.thinkingOptionId = level;
  }
}

export class PaseoAgentClient implements AgentClient {
  readonly provider = PASEO_AGENT_PROVIDER;
  readonly capabilities = PASEO_AGENT_CAPABILITIES;

  private readonly logger: Logger;
  private readonly config: PaseoAgentConfig;
  private readonly paseoHome: string | undefined;

  constructor(options: PaseoAgentClientOptions) {
    this.logger = options.logger;
    this.config = options.config;
    this.paseoHome = options.paseoHome;
  }

  async createSession(
    config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const inferenceProviders = paseoAgentInferenceProviders(this.config);
    if (inferenceProviders.length === 0) {
      throw new Error(
        "Paseo Agent has no configured inference providers. Add agents.paseo.providers to your Paseo config.",
      );
    }

    const profile = this.loadDefaultProfile();
    this.verifyExpectedMcpServers(profile?.expectedMcpServers ?? [], config.mcpServers);
    const model = resolvePaseoAgentModel(
      this.config,
      config.model,
      inferenceProviders,
      profile?.model,
    );
    const thinkingLevel = normalizeThinkingLevel(config.thinkingOptionId) ?? undefined;
    const composedPrompt = composePromptParts({
      profile,
      systemPrompt: config.systemPrompt,
      daemonAppendSystemPrompt: config.daemonAppendSystemPrompt,
    });
    this.logger.debug(
      {
        provider: PASEO_AGENT_PROVIDER,
        model: model ? `${model.provider}/${model.id}` : null,
        promptProfile: profile?.id ?? null,
      },
      "Creating Paseo Agent session",
    );

    // OAuth providers (ChatGPT/Codex) use a Paseo-owned, file-backed AuthStorage so Pi
    // reads the stored credential and persists refreshed tokens (rotation) back to it.
    const usesOAuth = inferenceProviders.some((provider) => provider.oauth);
    const authStorage = usesOAuth ? createPaseoAgentAuthStorage() : undefined;

    // Bridge Paseo-injected MCP servers (e.g. the `paseo` HTTP server) into Pi tools.
    const mcpBridge = await createMcpToolBridge({
      mcpServers: config.mcpServers,
      logger: this.logger,
    });

    try {
      const handle = await createPaseoAgentSession({
        cwd: config.cwd,
        agentDir: resolveIsolatedAgentDir(),
        inferenceProviders,
        ...(model ? { model } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(authStorage ? { authStorage } : {}),
        ...(mcpBridge.tools.length > 0 ? { customTools: mcpBridge.tools } : {}),
        ...(composedPrompt ? { composedPrompt } : {}),
      });
      return new PaseoAgentSession(handle, config, mcpBridge);
    } catch (error) {
      await mcpBridge.close();
      throw error;
    }
  }

  async resumeSession(): Promise<AgentSession> {
    throw new Error("Paseo Agent does not support session resume in this prototype");
  }

  async listModels(_options: ListModelsOptions): Promise<AgentModelDefinition[]> {
    return listPaseoAgentModels(this.config);
  }

  async isAvailable(): Promise<boolean> {
    return paseoAgentHasUsableModel(this.config, process.env, (providerInstance) =>
      hasStoredOAuthCredential(providerInstance),
    );
  }

  private loadDefaultProfile() {
    if (!this.paseoHome || !this.config.defaultProfile) {
      return null;
    }
    try {
      const profile = loadPromptProfile(this.paseoHome, this.config.defaultProfile);
      if (!profile) {
        this.logger.warn(
          { provider: PASEO_AGENT_PROVIDER, promptProfile: this.config.defaultProfile },
          "Configured Paseo Agent prompt profile was not found",
        );
      }
      return profile;
    } catch (error) {
      this.logger.warn(
        {
          provider: PASEO_AGENT_PROVIDER,
          promptProfile: this.config.defaultProfile,
          error: error instanceof Error ? error.message : String(error),
        },
        "Configured Paseo Agent prompt profile could not be loaded",
      );
      return null;
    }
  }

  private verifyExpectedMcpServers(
    expectedServers: string[],
    configuredServers: AgentSessionConfig["mcpServers"],
  ): void {
    for (const serverName of new Set(expectedServers)) {
      if (!configuredServers?.[serverName]) {
        this.logger.warn(
          {
            provider: PASEO_AGENT_PROVIDER,
            promptProfile: this.config.defaultProfile,
            mcpServer: serverName,
          },
          "Paseo Agent prompt profile expects an MCP server that is not configured for this session",
        );
      }
    }
  }
}
