/**
 * Hacker News Search Tool — search HN via the free Algolia API
 * NEVER throws — catches all errors and returns ToolResult with isError: true
 * No capability needed — the Algolia HN API is free and requires no API key
 */

import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import type { ResolvedEnv } from '../env.js';
import { HackerNewsClient, type HNSearchResult } from '../clients/hackernews.js';
import { formatSuccess, formatError, countMapValues } from '../lib/response.js';
import { classifyError } from '../lib/errors.js';

function formatHNResult(result: HNSearchResult): string {
  const hnUrl = `https://news.ycombinator.com/item?id=${result.objectID}`;
  const date = result.createdAt ? new Date(result.createdAt).toLocaleDateString() : 'unknown date';

  if (result.isStory) {
    let md = `- **${result.title}**\n`;
    md += `  ${result.points} points | ${result.numComments} comments | by ${result.author} | ${date}\n`;
    md += `  Discussion: ${hnUrl}\n`;
    if (result.url) {
      md += `  Article: ${result.url}\n`;
    }
    if (result.storyText) {
      const preview = result.storyText.length > 200 ? result.storyText.slice(0, 200) + '...' : result.storyText;
      md += `  > ${preview}\n`;
    }
    return md;
  } else {
    // Comment
    const preview = result.commentText
      ? (result.commentText.length > 200 ? result.commentText.slice(0, 200) + '...' : result.commentText)
      : '';
    let md = `- **Comment by ${result.author}** (${result.points} points, ${date})\n`;
    md += `  ${hnUrl}\n`;
    if (preview) {
      md += `  > ${preview}\n`;
    }
    return md;
  }
}

function formatQueryResults(query: string, results: HNSearchResult[]): string {
  if (results.length === 0) {
    return `### "${query}"\n\n_No results found._\n`;
  }

  let md = `### "${query}" (${results.length} results)\n\n`;
  for (const result of results) {
    md += formatHNResult(result);
    md += '\n';
  }
  return md;
}

// ── Schema ──

const schema = z.object({
  queries: z.array(z.string().min(1)).min(3).max(30)
    .describe('3-30 search queries for Hacker News'),
  type: z.enum(['story', 'comment', 'all']).optional().default('story')
    .describe('Type of content to search (default "story")'),
  sort_by: z.enum(['relevance', 'date']).optional().default('relevance')
    .describe('Sort results by relevance or date (default "relevance")'),
  date_range: z.enum(['day', 'week', 'month', 'year', 'all']).optional().default('year')
    .describe('Date range filter (default "year")'),
  min_points: z.number().int().min(0).optional().default(0)
    .describe('Minimum points/score filter (default 0)'),
});

export const hackernewsTool: ToolDefinition<typeof schema> = {
  name: 'search_hackernews',
  description: 'Search Hacker News via the free Algolia API. Find developer discussions, stories, and comments with date and score filtering.',
  inputSchema: schema,
  // No capability needed — free API, no key required

  async handler(params, env: ResolvedEnv): Promise<ToolResult> {
    try {
      const limited = params.queries.slice(0, 30);
      const client = new HackerNewsClient();

      const results = await client.searchMultiple(limited, {
        type: params.type,
        sortBy: params.sort_by,
        dateRange: params.date_range,
        minPoints: params.min_points,
      });

      const totalResults = countMapValues(results);
      if (totalResults === 0) {
        return {
          content: [{ type: 'text', text: formatError({
            code: 'NO_RESULTS',
            message: `No results found for any of the ${limited.length} queries`,
            toolName: 'search_hackernews',
            howToFix: [
              'Try broader or simpler search terms',
              'Check spelling of technical terms',
              'Relax date_range filter (try "year" or "all")',
              'Lower min_points filter',
            ],
            alternatives: [
              'web_search(keywords=["topic best practices", "topic guide"]) — search the broader web',
              'search_reddit(queries=["topic discussion", "topic recommendations"]) — try Reddit for community discussions',
            ],
          }) }],
          isError: true,
        };
      }

      // Build data section with per-query results
      const queryBlocks: string[] = [];
      for (const [query, hits] of results) {
        queryBlocks.push(formatQueryResults(query, hits));
      }

      // Collect story URLs for scrape suggestion
      const seenUrls = new Set<string>();
      const storyUrls: string[] = [];
      for (const hits of results.values()) {
        for (const hit of hits) {
          if (hit.url && !seenUrls.has(hit.url)) {
            seenUrls.add(hit.url);
            storyUrls.push(hit.url);
          }
        }
      }

      const summary = `Found **${totalResults} results** across **${limited.length} queries** from Hacker News.\n`
        + `Filters: type=${params.type || 'story'}, sort=${params.sort_by || 'relevance'}, range=${params.date_range || 'year'}`
        + (params.min_points ? `, min_points=${params.min_points}` : '');

      const nextSteps: string[] = [
        storyUrls.length > 0
          ? `scrape_links(urls=[${storyUrls.slice(0, 3).map(u => `"${u}"`).join(', ')}...], use_llm=true) — scrape linked articles for full content`
          : null,
        'search_reddit(queries=["topic discussion", "topic recommendations"]) — cross-platform comparison with Reddit',
        'web_search(keywords=["topic latest", "topic official docs"]) — verify claims from HN discussions',
        'deep_research(questions=[{question: "Based on HN discussions about [topic], synthesize key insights"}]) — synthesize findings',
      ].filter(Boolean) as string[];

      const md = formatSuccess({
        title: `Hacker News Search (${totalResults} results from ${limited.length} queries)`,
        summary,
        data: queryBlocks.join('\n---\n\n'),
        nextSteps,
      });

      return { content: [{ type: 'text', text: md }] };
    } catch (error) {
      const err = classifyError(error);
      return {
        content: [{ type: 'text', text: formatError({
          code: err.code,
          message: err.message,
          retryable: err.retryable,
          toolName: 'search_hackernews',
          howToFix: ['The Algolia HN API is free and needs no API key — this may be a temporary network issue'],
          alternatives: [
            'web_search(keywords=["topic site:news.ycombinator.com"]) — search HN via Google as fallback',
            'search_reddit(queries=["topic discussion"]) — try Reddit for similar developer discussions',
          ],
        }) }],
        isError: true,
      };
    }
  },
};
