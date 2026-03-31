import type { ResolvedEnv } from '../env.js';
import { getCapabilities } from '../env.js';
import { createSession, touchSession } from './session.js';
import { jsonRpcResponse, jsonRpcError, MCP_ERROR } from './protocol.js';
import { getAllTools, executeTool } from '../tools/index.js';

interface McpResult {
  body: unknown;
  sessionId?: string;
}

export async function handleMcpRequest(
  body: {
    jsonrpc: string;
    method: string;
    params?: Record<string, unknown>;
    id?: string | number;
  },
  sessionId: string | undefined,
  env: ResolvedEnv
): Promise<McpResult> {
  const { method, params, id } = body;
  const ttlSeconds = parseInt(env.SESSION_TTL_SECONDS, 10) || 2592000;

  switch (method) {
    case 'initialize': {
      const newSessionId = crypto.randomUUID();
      await createSession(env.MCP_SESSIONS, newSessionId, {
        protocolVersion:
          (params?.protocolVersion as string) || env.MCP_PROTOCOL_VERSION,
        ttlSeconds,
      });

      return {
        sessionId: newSessionId,
        body: jsonRpcResponse(id, {
          protocolVersion: env.MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: env.SERVER_NAME,
            version: env.SERVER_VERSION,
          },
        }),
      };
    }

    case 'notifications/initialized': {
      if (sessionId) await touchSession(env.MCP_SESSIONS, sessionId, ttlSeconds);
      return { body: null };
    }

    case 'tools/list': {
      if (sessionId) await touchSession(env.MCP_SESSIONS, sessionId, ttlSeconds);
      const capabilities = getCapabilities(env);
      const tools = getAllTools(capabilities);
      return { body: jsonRpcResponse(id, { tools }) };
    }

    case 'tools/call': {
      if (sessionId) await touchSession(env.MCP_SESSIONS, sessionId, ttlSeconds);
      const capabilities = getCapabilities(env);
      const toolName = params?.name as string;
      const toolArgs = (params?.arguments as Record<string, unknown>) || {};

      try {
        const result = await executeTool(toolName, toolArgs, capabilities, env);
        return { body: jsonRpcResponse(id, result) };
      } catch (error) {
        return {
          body: jsonRpcResponse(id, {
            content: [
              {
                type: 'text',
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          }),
        };
      }
    }

    case 'ping': {
      if (sessionId) await touchSession(env.MCP_SESSIONS, sessionId, ttlSeconds);
      return { body: jsonRpcResponse(id, {}) };
    }

    default: {
      return {
        body: jsonRpcError(id, MCP_ERROR.METHOD_NOT_FOUND, `Method not found: ${method}`),
      };
    }
  }
}
