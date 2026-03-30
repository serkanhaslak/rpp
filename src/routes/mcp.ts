import { Hono } from 'hono';
import type { Env, ResolvedEnv } from '../env.js';
import { requireOAuth } from '../middleware/auth.js';
import { handleMcpRequest } from '../mcp/handler.js';
import { getSession, deleteSession } from '../mcp/session.js';
import { jsonRpcError, MCP_ERROR } from '../mcp/protocol.js';

export const mcpRoutes = new Hono<{
  Bindings: Env;
  Variables: { authenticated: boolean; resolved: ResolvedEnv };
}>();

// Auth on all MCP routes
mcpRoutes.use('*', requireOAuth);

// POST /mcp — Main JSON-RPC handler
mcpRoutes.post('/', async (c) => {
  let body: { jsonrpc: string; method: string; params?: Record<string, unknown>; id?: string | number };
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      jsonRpcError(undefined, MCP_ERROR.PARSE_ERROR, 'Parse error: invalid JSON'),
      400
    );
  }

  const env = c.get('resolved');
  const sessionId = c.req.header('mcp-session-id');

  if (body.method !== 'initialize' && sessionId) {
    const session = await getSession(env.MCP_SESSIONS, sessionId);
    if (!session) {
      return c.json(
        jsonRpcError(body.id, MCP_ERROR.INVALID_REQUEST, 'Session expired or invalid. Send initialize to create a new session.'),
        400
      );
    }
  }

  const result = await handleMcpRequest(body, sessionId, env);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (result.sessionId) {
    headers['mcp-session-id'] = result.sessionId;
  }
  if (result.body === null) {
    return new Response(null, { status: 204, headers });
  }

  return c.json(result.body as object, { headers });
});

// GET /mcp — Session info
mcpRoutes.get('/', async (c) => {
  const sessionId = c.req.header('mcp-session-id');
  if (!sessionId) {
    return c.json({ error: 'Missing mcp-session-id header' }, 400);
  }

  const env = c.get('resolved');
  const session = await getSession(env.MCP_SESSIONS, sessionId);
  if (!session) {
    return c.json({ error: 'Session not found or expired' }, 404);
  }

  return c.json({
    sessionId,
    active: true,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    protocolVersion: session.protocolVersion,
  });
});

// DELETE /mcp — Terminate session
mcpRoutes.delete('/', async (c) => {
  const env = c.get('resolved');
  const sessionId = c.req.header('mcp-session-id');
  if (sessionId) {
    await deleteSession(env.MCP_SESSIONS, sessionId);
  }
  return c.json({ success: true });
});
