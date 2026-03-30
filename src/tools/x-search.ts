/**
 * X/Twitter Search Tool — search X posts via Grok + OpenRouter
 * NEVER throws — catches all errors and returns ToolResult with isError: true
 */

import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import type { ResolvedEnv } from '../env.js';
import { OpenRouterClient, type XSearchQuery, type XSearchResult } from '../clients/openrouter.js';
import { formatSuccess, formatError } from '../lib/response.js';
import { classifyError } from '../lib/errors.js';

// ── Constants ──

const MAX_CONCURRENCY = 5;

// ── Formatters ──

function formatSingleResult(result: XSearchResult): string {
  const parts: string[] = [];

  if (result.error) {
    parts.push(`### "${result.query}" — Error\n`);
    parts.push(`**${result.error.code}:** ${result.error.message}\n`);
    return parts.join('\n');
  }

  parts.push(`### "${result.query}"\n`);

  if (result.content) {
    parts.push(result.content);
  } else {
    parts.push('_No results found for this query._');
  }

  const xLinks = result.annotations.filter(a => a.url.includes('x.com') || a.url.includes('twitter.com'));
  if (xLinks.length > 0) {
    parts.push('\n**X Post Links:**');
    for (const link of xLinks) {
      parts.push(`- [${link.title || link.url}](${link.url})`);
    }
  }

  if (result.usage) {
    parts.push(`\n_Tokens: ${result.usage.totalTokens.toLocaleString()}_`);
  }

  return parts.join('\n');
}

function formatResults(results: XSearchResult[]): string {
  return results.map(formatSingleResult).join('\n\n---\n\n');
}

// ── Schema ──

const schema = z.object({
  queries: z.array(z.string().min(1)).min(1).max(20)
    .describe('1-20 search queries for X/Twitter'),
  from_handles: z.array(z.string()).max(10).optional()
    .describe('Only search posts from these handles (without @ prefix, max 10)'),
  exclude_handles: z.array(z.string()).max(10).optional()
    .describe('Exclude posts from these handles (without @ prefix, max 10)'),
  from_date: z.string().optional()
    .describe('Only return posts after this date (YYYY-MM-DD format)'),
  to_date: z.string().optional()
    .describe('Only return posts before this date (YYYY-MM-DD format)'),
});

export const xSearchTool: ToolDefinition<typeof schema> = {
  name: 'search_x',
  description: 'Search X/Twitter posts via Grok on OpenRouter. Supports handle filtering and date ranges for targeted social media research.',
  inputSchema: schema,
  capability: 'xSearch',

  async handler(params, env: ResolvedEnv): Promise<ToolResult> {
    try {
      const { queries, from_handles, exclude_handles, from_date, to_date } = params;

      const searchQueries: XSearchQuery[] = queries.map(q => ({
        query: q,
        ...(from_handles ? { from_handles } : {}),
        ...(exclude_handles ? { exclude_handles } : {}),
        ...(from_date ? { from_date } : {}),
        ...(to_date ? { to_date } : {}),
      }));

      const client = new OpenRouterClient(env.OPENROUTER_API_KEY!);
      const results = await client.xSearchMultiple(searchQueries, MAX_CONCURRENCY);

      let successCount = 0;
      let failCount = 0;
      let totalCitations = 0;
      let totalTokens = 0;
      for (const r of results) {
        if (r.error) failCount++;
        else if (r.content) successCount++;
        totalCitations += r.annotations.length;
        totalTokens += r.usage?.totalTokens || 0;
      }

      if (successCount === 0) {
        return {
          content: [{ type: 'text', text: formatError({
            code: 'NO_RESULTS',
            message: `No X/Twitter results found for any of the ${queries.length} queries`,
            toolName: 'search_x',
            howToFix: [
              'Try broader or simpler search terms',
              'Remove date filters to search all time',
              'Remove handle filters to search all users',
              'Check that @handles are spelled correctly (without the @ prefix)',
            ],
            alternatives: [
              'web_search(keywords=["topic site:x.com"]) — search via Google for indexed X posts',
              'search_reddit(queries=["topic"]) — check Reddit for discussions about X posts',
            ],
          }) }],
          isError: true,
        };
      }

      const formattedData = formatResults(results);

      const filterDesc: string[] = [];
      if (from_handles?.length) filterDesc.push(`from: @${from_handles.join(', @')}`);
      if (exclude_handles?.length) filterDesc.push(`excluding: @${exclude_handles.join(', @')}`);
      if (from_date) filterDesc.push(`after: ${from_date}`);
      if (to_date) filterDesc.push(`before: ${to_date}`);
      const filterLabel = filterDesc.length > 0 ? ` | Filters: ${filterDesc.join(', ')}` : '';

      const md = formatSuccess({
        title: `X/Twitter Search: ${successCount}/${queries.length} queries returned results${filterLabel}`,
        summary: `Searched ${queries.length} queries on X/Twitter via Grok. ${successCount} returned results, ${failCount} failed. ${totalCitations} citations found. ${totalTokens.toLocaleString()} tokens used.`,
        data: formattedData,
        nextSteps: [
          `scrape_links(urls=[...X post URLs above...], use_llm=true, what_to_extract="post content|author|engagement|replies|context") — get full post content`,
          `search_x(queries=[...follow-up angles...]) — search for related X discussions`,
          `search_reddit(queries=["topic"]) — cross-reference with Reddit community discussions`,
          `deep_research(questions=[{question: "Based on X/Twitter discussions about [topic], what are the key insights?"}]) — synthesize findings`,
          `web_search(keywords=["topic"]) — get broader web context beyond social media`,
        ],
      });

      return { content: [{ type: 'text', text: md }] };
    } catch (error) {
      const err = classifyError(error);
      return {
        content: [{ type: 'text', text: formatError({
          code: err.code,
          message: err.message,
          retryable: err.retryable,
          toolName: 'search_x',
          howToFix: [
            'Verify OPENROUTER_API_KEY is set and has credits',
            'The Grok model on OpenRouter may be temporarily unavailable — try again',
          ],
          alternatives: [
            'web_search(keywords=["topic site:x.com"]) — search Google for X posts (uses SERPER_API_KEY instead)',
            'search_reddit(queries=["topic"]) — search Reddit as alternative social platform',
            'search_hackernews(queries=["topic"]) — search Hacker News for tech discussions',
          ],
        }) }],
        isError: true,
      };
    }
  },
};
