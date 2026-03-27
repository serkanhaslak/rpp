#!/usr/bin/env node

/**
 * Research Powerpack MCP Server
 * Implements robust error handling - server NEVER crashes on tool failures
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';

import { TOOLS } from './tools/definitions.js';
import { executeTool, getToolCapabilities } from './tools/registry.js';
import { classifyError, createToolErrorFromStructured } from './utils/errors.js';
import { SERVER, getCapabilities } from './config/index.js';
import { initLogger } from './utils/logger.js';
import { initUsageTracker, shutdownUsageTracker } from './services/usage-tracker.js';
import { isAuthEnabled, validateRequest, sendUnauthorized, handleOAuth } from './auth.js';

const BROKEN_PIPE_ERROR_CODES = new Set([
  'EPIPE',
  'EIO',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
]);

const DEFAULT_MCP_PORT = 3000 as const;

function extractErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const maybeCode = (error as { code?: unknown }).code;
  return typeof maybeCode === 'string' ? maybeCode : undefined;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error);
}

function isBrokenPipeLikeError(error: unknown): boolean {
  const code = extractErrorCode(error);
  if (code && BROKEN_PIPE_ERROR_CODES.has(code)) return true;

  const message = extractErrorMessage(error).toLowerCase();
  return (
    message.includes('epipe') ||
    message.includes('eio') ||
    message.includes('broken pipe') ||
    message.includes('stream destroyed') ||
    message.includes('write after end')
  );
}

function safeStderrWrite(line: string): void {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // Swallow stderr failures while shutting down from stream errors.
  }
}

let streamExitInProgress = false;
let fatalHandlerInProgress = false;

function exitOnBrokenPipe(source: string, error: unknown): void {
  if (streamExitInProgress || !isBrokenPipeLikeError(error)) return;
  streamExitInProgress = true;
  safeStderrWrite(`[MCP Server] ${source} broken pipe at ${new Date().toISOString()}, exiting`);
  process.exit(fatalHandlerInProgress ? 1 : 0);
}

// Install stream guards early (before startup logs) to avoid orphaned hot loops.
process.stdout.on('error', (err) => exitOnBrokenPipe('stdout', err));
process.stderr.on('error', (err) => exitOnBrokenPipe('stderr', err));

// ============================================================================
// Capability Detection (uses registry for tool capability mapping)
// ============================================================================

const capabilities = getCapabilities();
const { enabled: enabledTools, disabled: disabledTools } = getToolCapabilities();

if (enabledTools.length > 0) {
  console.error(`✅ Enabled tools: ${enabledTools.join(', ')}`);
}
if (disabledTools.length > 0) {
  console.error(`⚠️ Disabled tools (missing ENV): ${disabledTools.join(', ')}`);
}
if (capabilities.scraping && !capabilities.llmExtraction) {
  console.error(`ℹ️ scrape_links: AI extraction (use_llm) disabled - set OPENROUTER_API_KEY to enable`);
}

// ============================================================================
// Server Setup
// ============================================================================

/**
 * Register shared tool handlers on any Server instance.
 * Used by both STDIO and HTTP session servers to avoid duplication.
 */
function registerToolHandlers(srv: Server): void {
  srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  srv.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await executeTool(name, args, capabilities);
    } catch (error) {
      if (error instanceof McpError) throw error;
      const structuredError = classifyError(error);
      console.error(`[MCP Server] Tool "${name}" error:`, {
        code: structuredError.code,
        message: structuredError.message,
        retryable: structuredError.retryable,
      });
      return createToolErrorFromStructured(structuredError);
    }
  });
}

const server = new Server(
  { name: SERVER.NAME, version: SERVER.VERSION },
  { capabilities: { tools: {}, logging: {} } }
);

initLogger(server);
initUsageTracker();
registerToolHandlers(server);

// ============================================================================
// Global Error Handlers - MUST EXIT on fatal errors per Node.js best practices
// See: https://nodejs.org/api/process.html#warning-using-uncaughtexception-correctly
// ============================================================================

// Track shutdown state to prevent double shutdown
let isShuttingDown = false;

/**
 * Graceful shutdown handler - closes server and exits
 * @param exitCode - Exit code (0 for clean shutdown, 1 for error)
 */
async function gracefulShutdown(exitCode: number): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  try {
    shutdownUsageTracker();
    await server.close();
    safeStderrWrite(`[MCP Server] Server closed at ${new Date().toISOString()}`);
  } catch (closeError) {
    if (isBrokenPipeLikeError(closeError)) {
      // Preserve caller intent: fatal paths should still exit non-zero.
      process.exit(exitCode);
      return;
    }
    safeStderrWrite(`[MCP Server] Error closing server: ${safeErrorString(closeError)}`);
  } finally {
    process.exit(exitCode);
  }
}

/**
 * Safely extract error information without triggering another exception
 * Prevents infinite loops when error objects have problematic getters
 */
function safeErrorString(error: unknown): string {
  try {
    if (error instanceof Error) {
      // Try to get message and stack safely
      const message = String(error.message || 'Unknown error');
      try {
        const stack = String(error.stack || '');
        if (!stack) {
          return message;
        }
        // Avoid duplicating the message when the stack already includes it
        return stack.includes(message) ? stack : `${message}\n${stack}`;
      } catch {
        return message; // Stack serialization failed, just return message
      }
    }
    return String(error);
  } catch {
    // Even String() can fail on some objects
    return '[Error: Unable to serialize error object]';
  }
}

// Handle uncaught exceptions - MUST EXIT per Node.js docs
// The VM is in an unstable state after uncaught exception

process.on('uncaughtException', (error: Error) => {
  if (isBrokenPipeLikeError(error)) {
    exitOnBrokenPipe('uncaughtException', error);
    return;
  }
  if (fatalHandlerInProgress) {
    process.exit(1);
    return;
  }
  fatalHandlerInProgress = true;

  try {
    safeStderrWrite(`[MCP Server] FATAL uncaughtException at ${new Date().toISOString()}:`);
    safeStderrWrite(safeErrorString(error));
  } catch {
    // Even logging failed - just exit
    safeStderrWrite('[MCP Server] FATAL uncaughtException (unable to log details)');
  }
  gracefulShutdown(1).catch(() => process.exit(1));
});

// Handle unhandled promise rejections - MUST EXIT (Node v15+ behavior)
// Suppressing this risks memory leaks and corrupted state
process.on('unhandledRejection', (reason: unknown) => {
  if (isBrokenPipeLikeError(reason)) {
    exitOnBrokenPipe('unhandledRejection', reason);
    return;
  }
  if (fatalHandlerInProgress) {
    process.exit(1);
    return;
  }
  fatalHandlerInProgress = true;

  try {
    const error = classifyError(reason);
    safeStderrWrite(`[MCP Server] FATAL unhandledRejection at ${new Date().toISOString()}:`);
    safeStderrWrite(`  Message: ${error.message}`);
    safeStderrWrite(`  Code: ${error.code}`);
  } catch {
    // classifyError or logging failed, use safeErrorString as fallback
    safeStderrWrite('[MCP Server] FATAL unhandledRejection (unable to classify error):');
    safeStderrWrite(safeErrorString(reason));
  }
  gracefulShutdown(1).catch(() => process.exit(1));
});

// Handle SIGTERM gracefully (Docker/Kubernetes stop signal)
process.on('SIGTERM', () => {
  safeStderrWrite(`[MCP Server] Received SIGTERM at ${new Date().toISOString()}, shutting down gracefully`);
  gracefulShutdown(0);
});

// Handle SIGINT gracefully (Ctrl+C) - use once() to prevent double-fire
process.once('SIGINT', () => {
  safeStderrWrite(`[MCP Server] Received SIGINT at ${new Date().toISOString()}, shutting down gracefully`);
  gracefulShutdown(0);
});

// ============================================================================
// Stdin disconnect detection
// The MCP SDK's StdioServerTransport does NOT listen for stdin 'close'/'end'.
// When the parent process disconnects (closes the pipe), stdin emits these
// events but nobody handles them — Node.js keeps polling the dead fd at 100%
// CPU. We fix this by detecting the disconnect and exiting cleanly.
// ============================================================================

process.stdin.on('close', () => {
  safeStderrWrite(`[MCP Server] stdin closed (parent disconnected) at ${new Date().toISOString()}, shutting down`);
  gracefulShutdown(0);
});

process.stdin.on('end', () => {
  safeStderrWrite(`[MCP Server] stdin ended (parent disconnected) at ${new Date().toISOString()}, shutting down`);
  gracefulShutdown(0);
});

// ============================================================================
// Start Server — STDIO (default) or HTTP Streamable (MCP_TRANSPORT=http)
// ============================================================================

const transportMode = (process.env.MCP_TRANSPORT || 'stdio').toLowerCase();

if (transportMode === 'http') {
  // HTTP Streamable transport — stateful sessions over HTTP
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );
  const { createServer: createHttpServer } = await import('node:http');
  const { randomUUID } = await import('node:crypto');

  const PORT = parseInt(process.env.MCP_PORT || process.env.PORT || String(DEFAULT_MCP_PORT), 10);

  // Session TTL — reap idle sessions to prevent memory leaks from clients that disconnect without DELETE
  const SESSION_TTL_MS = Math.max(60_000,
    parseInt(process.env.SESSION_TTL_MS || '', 10) || 30 * 60 * 1000); // default 30min
  const SESSION_REAP_INTERVAL_MS = 60 * 1000; // sweep every 1 min

  // Max concurrent sessions — evict least-recently-used when exceeded
  const MAX_SESSIONS = Math.max(1, parseInt(process.env.MAX_SESSIONS || '', 10) || 100);

  type SessionEntry = {
    transport: InstanceType<typeof StreamableHTTPServerTransport>;
    server: Server;
    lastActivity: number;
  };

  // Map of session ID → transport + server for multi-session support
  const sessions = new Map<string, SessionEntry>();

  /** Safely close a session's server, ignoring errors. */
  async function closeSession(session: SessionEntry, sessionId: string): Promise<void> {
    sessions.delete(sessionId);
    try { await session.server.close(); } catch { /* ignore close errors */ }
  }

  /** Evict the least-recently-active session (oldest lastActivity). */
  async function evictLeastRecentSession(): Promise<void> {
    let oldestId: string | undefined;
    let oldestTime = Infinity;
    for (const [id, entry] of sessions) {
      if (entry.lastActivity < oldestTime) {
        oldestTime = entry.lastActivity;
        oldestId = id;
      }
    }
    if (oldestId) {
      const session = sessions.get(oldestId)!;
      console.error(`[HTTP] Evicting LRU session ${oldestId} (idle ${Math.round((Date.now() - oldestTime) / 1000)}s, active: ${sessions.size})`);
      await closeSession(session, oldestId);
    }
  }

  /** Handle GET /mcp — resume existing session's SSE stream. */
  async function handleMcpGet(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    sessionId: string | undefined,
  ): Promise<void> {
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      session.lastActivity = Date.now();
      await session.transport.handleRequest(req, res);
    } else {
      res.writeHead(400).end('Bad request — missing session ID');
    }
  }

  /** Handle POST /mcp — route to existing session or create a new one. */
  async function handleMcpPost(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    sessionId: string | undefined,
  ): Promise<void> {
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      session.lastActivity = Date.now();
      await session.transport.handleRequest(req, res);
      return;
    }

    if (sessionId) {
      res.writeHead(400).end('Bad request — missing session ID');
      return;
    }

    // Evict oldest session if at capacity — better UX than rejecting with 503
    if (sessions.size >= MAX_SESSIONS) {
      try {
        await evictLeastRecentSession();
      } catch { /* never crash — eviction is best-effort */ }
    }

    // New session (initialization)
    const sessionServer = new Server(
      { name: SERVER.NAME, version: SERVER.VERSION },
      { capabilities: { tools: {}, logging: {} } }
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server: sessionServer, lastActivity: Date.now() });
        console.error(`[HTTP] Session ${id} initialized (active: ${sessions.size})`);
      },
      onsessionclosed: async (id) => {
        const session = sessions.get(id);
        if (session) {
          await closeSession(session, id);
        }
        console.error(`[HTTP] Session ${id} closed`);
      },
    });

    // Note: initLogger overwrites a global serverRef, so logs from all
    // HTTP sessions route to the most-recently-initialized session.
    // A true per-session logger is out of scope for this fix.
    initLogger(sessionServer);
    registerToolHandlers(sessionServer);

    await sessionServer.connect(transport);
    await transport.handleRequest(req, res);
  }

  /** Handle DELETE /mcp — terminate a session. */
  async function handleMcpDelete(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    sessionId: string | undefined,
  ): Promise<void> {
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res);
      await closeSession(session, sessionId);
    } else {
      res.writeHead(404).end('Session not found');
    }
  }

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);

    // OAuth routes (discovery, authorize, token)
    if (isAuthEnabled() && await handleOAuth(req, res, url)) return;

    // Health check
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', name: SERVER.NAME, version: SERVER.VERSION, activeSessions: sessions.size }));
      return;
    }

    // MCP endpoint
    if (url.pathname === '/mcp') {
      if (isAuthEnabled() && !validateRequest(req)) {
        sendUnauthorized(req, res);
        return;
      }
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      switch (req.method) {
        case 'DELETE':
          await handleMcpDelete(req, res, sessionId);
          return;
        case 'GET':
          await handleMcpGet(req, res, sessionId);
          return;
        case 'POST':
          await handleMcpPost(req, res, sessionId);
          return;
        default:
          res.writeHead(405).end('Method not allowed');
          return;
      }
    }

    res.writeHead(404).end('Not found');
  });

  httpServer.listen(PORT, () => {
    console.error(`🚀 ${SERVER.NAME} v${SERVER.VERSION} listening on http://localhost:${PORT}/mcp`);
    console.error(`   Sessions: max=${MAX_SESSIONS}, ttl=${SESSION_TTL_MS / 1000}s, reap_interval=${SESSION_REAP_INTERVAL_MS / 1000}s`);
  });

  // Session reaper — close sessions idle beyond SESSION_TTL_MS
  const sessionReapInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > SESSION_TTL_MS) {
        console.error(`[HTTP] Reaping idle session ${id} (idle ${Math.round((now - session.lastActivity) / 1000)}s, active: ${sessions.size - 1})`);
        closeSession(session, id).catch(() => {/* ignore */});
      }
    }
  }, SESSION_REAP_INTERVAL_MS);
  sessionReapInterval.unref(); // Don't prevent process exit
} else {
  // STDIO transport (default)
  const transport = new StdioServerTransport();

  try {
    await server.connect(transport);
    console.error(`🚀 ${SERVER.NAME} v${SERVER.VERSION} ready (stdio)`);
  } catch (error) {
    const err = classifyError(error);
    console.error(`[MCP Server] Failed to start: ${err.message}`);
    process.exit(1);
  }
}
