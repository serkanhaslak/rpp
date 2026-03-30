#!/usr/bin/env node
/// <reference types="node" />
/**
 * STDIO entry point for Claude Desktop / Claude Code.
 * Shares tool definitions and handlers with the Workers entry.
 * Reads env from process.env (standard for STDIO MCP servers).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { getAllTools, executeTool } from './tools/index.js';
import { getCapabilities } from './env.js';
import type { ResolvedEnv } from './env.js';

// Build Env-like object from process.env for STDIO mode
function buildEnvFromProcessEnv(): ResolvedEnv {
  return {
    // KV not available in STDIO — tools that need KV will gracefully degrade
    OAUTH_TOKENS: null as unknown as KVNamespace,
    MCP_SESSIONS: null as unknown as KVNamespace,

    SERVER_NAME: 'research-mcp',
    SERVER_VERSION: process.env.npm_package_version || '5.0.0',
    MCP_PROTOCOL_VERSION: '2025-11-25',
    SESSION_TTL_SECONDS: '1800',
    MAX_SESSIONS: '100',

    // API keys from process.env
    SERPER_API_KEY: process.env.SERPER_API_KEY,
    REDDIT_CLIENT_ID: process.env.REDDIT_CLIENT_ID,
    REDDIT_CLIENT_SECRET: process.env.REDDIT_CLIENT_SECRET,
    SCRAPEDO_API_KEY: process.env.SCRAPEDO_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,

    OAUTH_CLIENT_ID: '',
    OAUTH_CLIENT_SECRET: '',

    RESEARCH_MODEL: process.env.RESEARCH_MODEL,
    RESEARCH_FALLBACK_MODEL: process.env.RESEARCH_FALLBACK_MODEL,
    LLM_EXTRACTION_MODEL: process.env.LLM_EXTRACTION_MODEL,
    DEFAULT_REASONING_EFFORT: process.env.DEFAULT_REASONING_EFFORT,
    DEFAULT_MAX_URLS: process.env.DEFAULT_MAX_URLS,
    API_TIMEOUT_MS: process.env.API_TIMEOUT_MS,
  };
}

async function main() {
  const env = buildEnvFromProcessEnv();
  const capabilities = getCapabilities(env);

  const server = new Server(
    { name: env.SERVER_NAME, version: env.SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getAllTools(capabilities),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return executeTool(name, args || {}, capabilities, env);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
  process.stdin.on('end', shutdown);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
