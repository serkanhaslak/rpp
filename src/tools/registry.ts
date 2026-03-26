/**
 * Handler Registry - Central tool registration and execution
 * Eliminates repetitive if/else routing with declarative registration
 */

import { z, ZodError } from 'zod';
import { McpError, ErrorCode as McpErrorCode } from '@modelcontextprotocol/sdk/types.js';

import { parseEnv, getCapabilities, getMissingEnvMessage, type Capabilities } from '../config/index.js';
import { classifyError, createToolErrorFromStructured } from '../utils/errors.js';
import { sanitizeForJson } from '../utils/sanitize.js';
import { trackToolCall } from '../services/usage-tracker.js';

// Import schemas
import { deepResearchParamsSchema, type DeepResearchParams } from '../schemas/deep-research.js';
import { scrapeLinksParamsSchema, type ScrapeLinksParams } from '../schemas/scrape-links.js';
import { webSearchParamsSchema, type WebSearchParams } from '../schemas/web-search.js';
import { COMMENT_SORTS } from '../clients/reddit.js';

// Import handlers
import { handleSearchHackerNews } from './hackernews.js';
import { handleSearchNews } from './news.js';
import { handleSearchReddit, handleGetRedditPosts } from './reddit.js';
import { handleDeepResearch } from './research.js';
import { handleScrapeLinks } from './scrape.js';
import { handleWebSearch } from './search.js';
import { handleSearchX, type SearchXParams } from './xsearch.js';

// ============================================================================
// Types
// ============================================================================

/**
 * MCP-compliant tool result with index signature for SDK compatibility
 */
export interface CallToolResult {
  readonly content: Array<{ readonly type: 'text'; readonly text: string }>;
  readonly isError?: boolean;
  [key: string]: unknown;
}

/**
 * Configuration for a registered tool
 */
export interface ToolRegistration {
  readonly name: string;
  readonly capability?: keyof Capabilities;
  readonly schema: z.ZodSchema;
  readonly handler: (params: unknown) => Promise<string>;
  readonly postValidate?: (params: unknown) => string | undefined;
  readonly transformResponse?: (result: string) => { content: string; isError?: boolean };
}

/**
 * Registry type
 */
export type ToolRegistry = Record<string, ToolRegistration>;

// ============================================================================
// Schemas for Simple Tools (inline definitions)
// ============================================================================

const searchRedditParamsSchema = z.object({
  queries: z.array(z.string()).min(3, 'search_reddit: MINIMUM 3 queries required. Add more diverse queries covering different perspectives.').max(50),
  date_after: z.string().optional(),
  subreddits: z.array(z.string()).max(10).optional()
    .describe('Optional: limit search to specific subreddits (e.g., ["python", "webdev"]). Max 10. Omit to search all of Reddit.'),
});

const getRedditPostParamsSchema = z.object({
  urls: z.array(z.string()).min(2).max(50)
    .describe('2-50 Reddit URLs. More = broader consensus. Get from search_reddit.'),
  fetch_comments: z.boolean().default(true)
    .describe('Fetch comments (true recommended - best insights in comments)'),
  max_comments: z.number().default(100)
    .describe('Override auto allocation. Leave empty for smart allocation.'),
  sort: z.enum(COMMENT_SORTS).default('top')
    .describe('Comment sort order. top=most upvoted, confidence=Reddit default (broadly agreed), new=recent, controversial=debates, qa=Q&A threads.'),
  use_llm: z.boolean().default(false)
    .describe('Default false — DO NOT enable unless user explicitly requests synthesis. Raw comments preserve exact quotes, code snippets, and nuanced opinions that LLM summarization loses.'),
  what_to_extract: z.string().optional()
    .describe('Only used when use_llm=true. Extraction instructions for AI synthesis.'),
});

const searchNewsParamsSchema = z.object({
  queries: z.array(z.string()).min(3, 'search_news: MINIMUM 3 queries required.').max(30),
  date_range: z.enum(['day', 'week', 'month', 'year']).optional()
    .describe('Filter by recency: day, week, month, year. Default: all time.'),
});

const searchHackerNewsParamsSchema = z.object({
  queries: z.array(z.string()).min(3, 'search_hackernews: MINIMUM 3 queries required.').max(30),
  type: z.enum(['story', 'comment', 'all']).default('story').optional()
    .describe('Filter: story (articles/links), comment (discussions), all (both).'),
  sort_by: z.enum(['relevance', 'date']).default('relevance').optional(),
  date_range: z.enum(['day', 'week', 'month', 'year', 'all']).default('year').optional(),
  min_points: z.number().min(0).default(0).optional()
    .describe('Minimum points/score filter. Use >50 for high-quality content.'),
});

const searchXParamsSchema = z.object({
  queries: z.array(z.string()).min(1, 'search_x: At least 1 query required.').max(20)
    .describe('1-20 X/Twitter search queries. Each runs as a separate Grok-powered X search in parallel. Use diverse queries for comprehensive coverage.'),
  from_handles: z.array(z.string()).max(10).optional()
    .describe('Only include posts from these X handles (max 10, without @ prefix). Cannot be used with exclude_handles.'),
  exclude_handles: z.array(z.string()).max(10).optional()
    .describe('Exclude posts from these X handles (max 10, without @ prefix). Cannot be used with from_handles.'),
  from_date: z.string().optional()
    .describe('Start date filter (ISO 8601, e.g. "2025-01-01")'),
  to_date: z.string().optional()
    .describe('End date filter (ISO 8601, e.g. "2025-12-31")'),
});

// ============================================================================
// Handler Wrappers
// ============================================================================

const env = parseEnv();

/**
 * Wrapper for search_reddit handler
 */
async function searchRedditHandler(params: unknown): Promise<string> {
  const p = params as z.infer<typeof searchRedditParamsSchema>;
  return handleSearchReddit(p.queries, env.SEARCH_API_KEY || '', p.date_after, p.subreddits);
}

/**
 * Wrapper for get_reddit_post handler
 */
async function getRedditPostHandler(params: unknown): Promise<string> {
  const p = params as z.infer<typeof getRedditPostParamsSchema>;
  return handleGetRedditPosts(
    p.urls,
    env.REDDIT_CLIENT_ID || '',
    env.REDDIT_CLIENT_SECRET || '',
    p.max_comments,
    {
      fetchComments: p.fetch_comments,
      maxCommentsOverride: p.max_comments !== 100 ? p.max_comments : undefined,
      sort: p.sort,
      use_llm: p.use_llm,
      what_to_extract: p.what_to_extract,
    }
  );
}

/**
 * Wrapper for search_news handler
 */
async function searchNewsHandler(params: unknown): Promise<string> {
  const p = params as z.infer<typeof searchNewsParamsSchema>;
  return handleSearchNews(p.queries, env.SEARCH_API_KEY || '', p.date_range);
}

/**
 * Wrapper for search_hackernews handler
 */
async function searchHackerNewsHandler(params: unknown): Promise<string> {
  const p = params as z.infer<typeof searchHackerNewsParamsSchema>;
  return handleSearchHackerNews(p.queries, {
    type: p.type,
    sort_by: p.sort_by,
    date_range: p.date_range,
    min_points: p.min_points,
  });
}

/**
 * Wrapper for deep_research handler
 */
async function deepResearchHandler(params: unknown): Promise<string> {
  const { content } = await handleDeepResearch(params as DeepResearchParams);
  return content;
}

/**
 * Wrapper for scrape_links handler
 */
async function scrapeLinksHandler(params: unknown): Promise<string> {
  const { content } = await handleScrapeLinks(params as ScrapeLinksParams);
  return content;
}

/**
 * Wrapper for web_search handler
 */
async function webSearchHandler(params: unknown): Promise<string> {
  const { content } = await handleWebSearch(params as WebSearchParams);
  return content;
}

async function searchXHandler(params: unknown): Promise<string> {
  return handleSearchX(params as SearchXParams);
}

// ============================================================================
// Tool Registry
// ============================================================================

/**
 * Central registry of all MCP tools
 */
export const toolRegistry: ToolRegistry = {
  search_news: {
    name: 'search_news',
    capability: 'search',
    schema: searchNewsParamsSchema,
    handler: searchNewsHandler,
  },

  search_hackernews: {
    name: 'search_hackernews',
    schema: searchHackerNewsParamsSchema,
    handler: searchHackerNewsHandler,
  },

  search_reddit: {
    name: 'search_reddit',
    capability: 'search',
    schema: searchRedditParamsSchema,
    handler: searchRedditHandler,
  },

  get_reddit_post: {
    name: 'get_reddit_post',
    capability: 'reddit',
    schema: getRedditPostParamsSchema,
    handler: getRedditPostHandler,
  },

  deep_research: {
    name: 'deep_research',
    capability: 'deepResearch',
    schema: deepResearchParamsSchema,
    handler: deepResearchHandler,
    transformResponse: (result) => ({
      content: result,
      isError: result.includes('# ❌ Error'),
    }),
  },

  scrape_links: {
    name: 'scrape_links',
    capability: 'scraping',
    schema: scrapeLinksParamsSchema,
    handler: scrapeLinksHandler,
    transformResponse: (result) => ({
      content: result,
      isError: result.includes('# ❌ Scraping Failed'),
    }),
  },

  web_search: {
    name: 'web_search',
    capability: 'search',
    schema: webSearchParamsSchema,
    handler: webSearchHandler,
    transformResponse: (result) => ({
      content: result,
      isError: result.includes('# ❌ web_search'),
    }),
  },

  search_x: {
    name: 'search_x',
    capability: 'xSearch',
    schema: searchXParamsSchema,
    handler: searchXHandler,
    transformResponse: (result) => ({
      content: result,
      isError: result.includes('# ❌ search_x'),
    }),
  },
};

// ============================================================================
// Execute Tool Helpers
// ============================================================================

/**
 * Validate params with Zod schema and optional post-validation.
 * Returns validated params or a CallToolResult error.
 */
function validateToolParams(
  tool: ToolRegistration,
  args: unknown,
): { params: unknown } | CallToolResult {
  let validatedParams: unknown;
  try {
    validatedParams = tool.schema.parse(args);
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues
        .map((i) => `- **${i.path.join('.') || 'root'}**: ${i.message}`)
        .join('\n');
      throw new McpError(
        McpErrorCode.InvalidParams,
        `Validation Error:\n${issues}`
      );
    }
    const structured = classifyError(error);
    return createToolErrorFromStructured(structured);
  }

  if (tool.postValidate) {
    const postError = tool.postValidate(validatedParams);
    if (postError) {
      return {
        content: [{ type: 'text', text: `# ❌ Validation Error\n\n${postError}` }],
        isError: true,
      };
    }
  }

  return { params: validatedParams };
}

/**
 * Build the final CallToolResult from a handler result string,
 * applying the tool's transformResponse if present.
 */
function buildToolResult(result: string, tool: ToolRegistration): CallToolResult {
  const safeResult = sanitizeForJson(result);
  if (tool.transformResponse) {
    const transformed = tool.transformResponse(safeResult);
    return {
      content: [{ type: 'text', text: transformed.content }],
      isError: transformed.isError,
    };
  }
  return {
    content: [{ type: 'text', text: safeResult }],
  };
}

// ============================================================================
// Execute Tool (Main Entry Point)
// ============================================================================

/**
 * Execute a tool by name with full middleware chain
 *
 * Middleware steps:
 * 1. Lookup tool in registry (throw McpError if not found)
 * 2. Check capability (return error response if missing)
 * 3. Validate params with Zod (return error response if invalid)
 * 4. Execute handler (catch and format any errors)
 * 5. Transform response if needed
 *
 * @param name - Tool name from request
 * @param args - Raw arguments from request
 * @param capabilities - Current capabilities from getCapabilities()
 * @returns MCP-compliant tool result
 */
export async function executeTool(
  name: string,
  args: unknown,
  capabilities: Capabilities
): Promise<CallToolResult> {
  const tool = toolRegistry[name];
  if (!tool) {
    throw new McpError(
      McpErrorCode.MethodNotFound,
      `Method not found: ${name}. Available tools: ${Object.keys(toolRegistry).join(', ')}`
    );
  }

  if (tool.capability && !capabilities[tool.capability]) {
    throw new McpError(
      McpErrorCode.InvalidRequest,
      getMissingEnvMessage(tool.capability)
    );
  }

  const validation = validateToolParams(tool, args);
  if ('content' in validation) return validation;

  const startTime = Date.now();
  let result: string;
  try {
    result = await tool.handler(validation.params);
  } catch (error) {
    const structured = classifyError(error);
    trackToolCall(name, Date.now() - startTime, false, undefined, structured.code);
    return createToolErrorFromStructured(structured);
  }

  trackToolCall(name, Date.now() - startTime, !result.includes('# ❌'), result);
  return buildToolResult(result, tool);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get list of all registered tool names
 */
export function getRegisteredToolNames(): string[] {
  return Object.keys(toolRegistry);
}

/**
 * Check if a tool is registered
 */
export function isToolRegistered(name: string): boolean {
  return name in toolRegistry;
}

/**
 * Get tool capabilities for logging
 */
export function getToolCapabilities(): { enabled: string[]; disabled: string[] } {
  const caps = getCapabilities();
  const enabled: string[] = [];
  const disabled: string[] = [];

  for (const [name, tool] of Object.entries(toolRegistry)) {
    const capKey = tool.capability;
    if (!capKey || caps[capKey]) {
      enabled.push(name);
    } else {
      disabled.push(name);
    }
  }

  return { enabled, disabled };
}
