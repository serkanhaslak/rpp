/**
 * News Search Tool — search Google News via Serper
 * NEVER throws — catches all errors and returns ToolResult with isError: true
 */

import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import type { ResolvedEnv } from '../env.js';
import { SerperClient, type NewsSearchResult } from '../clients/serper.js';
import { formatSuccess, formatError, countMapValues } from '../lib/response.js';
import { classifyError } from '../lib/errors.js';

function formatNewsResult(result: NewsSearchResult, index: number): string {
  const parts: string[] = [];
  parts.push(`**${index}. ${result.title}**`);
  const meta: string[] = [];
  if (result.source) meta.push(result.source);
  if (result.date) meta.push(result.date);
  if (meta.length > 0) {
    parts.push(`   _${meta.join(' | ')}_`);
  }
  if (result.snippet) {
    parts.push(`   ${result.snippet}`);
  }
  parts.push(`   ${result.url}`);
  return parts.join('\n');
}

function formatNewsResults(results: Map<string, NewsSearchResult[]>): string {
  const sections: string[] = [];
  let globalIndex = 1;

  for (const [query, items] of results) {
    if (items.length === 0) continue;
    sections.push(`### "${query}" (${items.length} results)\n`);
    for (const item of items) {
      sections.push(formatNewsResult(item, globalIndex++));
    }
    sections.push('');
  }

  return sections.join('\n');
}

// ── Schema ──

const schema = z.object({
  queries: z.array(z.string().min(1)).min(3).max(30)
    .describe('3-30 news search queries'),
  date_range: z.enum(['day', 'week', 'month', 'year']).optional()
    .describe('Filter by date range (day, week, month, year)'),
});

export const newsTool: ToolDefinition<typeof schema> = {
  name: 'search_news',
  description: 'Search Google News for recent articles and breaking stories. Supports date range filtering.',
  inputSchema: schema,
  capability: 'search',

  async handler(params, env: ResolvedEnv): Promise<ToolResult> {
    try {
      const limited = params.queries.slice(0, 30);
      const client = new SerperClient(env.SERPER_API_KEY!);
      const results = await client.searchNewsMultiple(limited, params.date_range);

      const totalResults = countMapValues(results);
      if (totalResults === 0) {
        return {
          content: [{ type: 'text', text: formatError({
            code: 'NO_RESULTS',
            message: `No news results found for any of the ${limited.length} queries`,
            toolName: 'search_news',
            howToFix: [
              'Try broader or simpler search terms',
              'Remove date_range filter to search all time',
              'Check spelling of names and technical terms',
            ],
            alternatives: [
              'web_search(keywords=["topic latest news", "topic announcement"]) — try general web search instead',
              'deep_research(questions=[{question: "What are the latest developments on [topic]?"}]) — AI-powered research synthesis',
            ],
          }) }],
          isError: true,
        };
      }

      const dateLabel = params.date_range ? ` (${params.date_range})` : '';
      const formattedData = formatNewsResults(results);

      const md = formatSuccess({
        title: `News Search Results: ${totalResults} articles from ${limited.length} queries${dateLabel}`,
        summary: `Found ${totalResults} news articles across ${limited.length} search queries.`,
        data: formattedData,
        nextSteps: [
          `scrape_links(urls=[...article URLs above...], use_llm=true, what_to_extract="key facts|quotes|data|timeline|impact") — get full article content`,
          `deep_research(questions=[{question: "Based on these news findings about [topic], what are the implications?"}]) — synthesize across articles`,
          `search_news(queries=[...follow-up angles...]) — search for related developments`,
          `web_search(keywords=["topic background", "topic analysis"]) — get broader context beyond news`,
          `search_reddit(queries=["topic discussion", "topic reaction"]) — see community reactions`,
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
          toolName: 'search_news',
          howToFix: ['Verify SERPER_API_KEY is set correctly'],
          alternatives: [
            'web_search(keywords=["topic latest news", "topic breaking"]) — uses the same API key, but try anyway',
            'deep_research(questions=[{question: "What are the latest news on [topic]?"}]) — uses OpenRouter API (different key)',
          ],
        }) }],
        isError: true,
      };
    }
  },
};
