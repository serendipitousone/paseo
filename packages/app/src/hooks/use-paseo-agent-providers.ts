import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  PaseoAgentSetProviderRequest,
  RedactedPaseoAgentProviderConfig,
} from "@getpaseo/protocol/messages";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export function paseoAgentProvidersQueryKey(serverId: string | null) {
  return ["paseo-agent-providers", serverId] as const;
}

function describeQueryError(error: unknown): string | null {
  if (!error) {
    return null;
  }
  return error instanceof Error ? error.message : String(error);
}

export type PaseoAgentSetProviderInput = Omit<PaseoAgentSetProviderRequest, "type" | "requestId">;

interface UsePaseoAgentProvidersResult {
  supported: boolean;
  providers: RedactedPaseoAgentProviderConfig[];
  defaultModel: string | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setProvider: (
    input: PaseoAgentSetProviderInput,
  ) => Promise<RedactedPaseoAgentProviderConfig | null>;
}

export function usePaseoAgentProviders(serverId: string | null): UsePaseoAgentProvidersResult {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  // COMPAT(paseoAgentConfig): added in v0.1.85, remove gate after 2026-11-30.
  const supported = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.paseoAgentConfig === true,
  );
  const queryKey = useMemo(() => paseoAgentProvidersQueryKey(serverId), [serverId]);

  const query = useQuery({
    queryKey,
    enabled: Boolean(supported && serverId && client && isConnected),
    staleTime: 30_000,
    queryFn: async () => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      return client.getPaseoAgentProviders();
    },
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const error = query.data?.error ?? describeQueryError(query.error);

  const setProviderMutation = useMutation({
    mutationFn: async (input: PaseoAgentSetProviderInput) => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      const result = await client.setPaseoAgentProvider(input);
      if (!result.success) {
        throw new Error(result.error ?? "Failed to save provider");
      }
      return result.provider;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });
  const { mutateAsync: setProviderAsync } = setProviderMutation;

  const setProvider = useCallback(
    (input: PaseoAgentSetProviderInput) => setProviderAsync(input),
    [setProviderAsync],
  );

  return {
    supported,
    providers: query.data?.providers ?? [],
    defaultModel: query.data?.defaultModel ?? null,
    isLoading: query.isLoading,
    error,
    refresh,
    setProvider,
  };
}
