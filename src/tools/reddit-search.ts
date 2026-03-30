/**
 * Reddit Search Tool — search Reddit via Google Serper (site:reddit.com)
 * NEVER throws — catches all errors and returns ToolResult with isError: true
 */

import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import type { ResolvedEnv } from '../env.js';
import { SerperClient } from '../clients/serper.js';
import { aggregateAndRankReddit, generateRedditEnhancedOutput } from '../lib/url-ranking.js';
import { formatError, countMapValues } from '../lib/response.js';
import { classifyError } from '../lib/errors.js';

const schema = z.object({
  queries: z.array(z.string().min(1)).min(3).max(50)
    .describe('3-50 Reddit search queries. Each becomes a separate site:reddit.com Google search.'),
  date_after: z.string().optional()
    .describe('Only return results after this date (YYYY-MM-DD format)'),
  subreddits: z.array(z.string()).max(10).optional()
    .describe('Limit search to specific subreddits (max 10)'),
});

export const redditSearchTool: ToolDefinition<typeof schema> = {
  name: 'search_reddit',
  description: 'Search Reddit via Google for community discussions, recommendations, and experiences. Uses site:reddit.com filtering for targeted results.',
  inputSchema: schema,
  capability: 'search',

  async handler(params, env: ResolvedEnv): Promise<ToolResult> {
    try {
      const limited = params.queries.slice(0, 50);
      const client = new SerperClient(env.SERPER_API_KEY!);
      const results = await client.searchRedditMultiple(limited, params.date_after, params.subreddits);

      const totalResults = countMapValues(results);
      if (totalResults === 0) {
        return {
          content: [{ type: 'text', text: formatError({
            code: 'NO_RESULTS',
            message: `No results found for any of the ${limited.length} queries`,
            toolName: 'search_reddit',
            howToFix: [
              'Try broader or simpler search terms',
              'Check spelling of technical terms',
              'Remove date filters if using them',
            ],
            alternatives: [
              'web_search(keywords=["topic best practices", "topic guide", "topic recommendations 2025"]) — get results from the broader web instead',
              'deep_research(questions=[{question: "What are the key findings about [topic]?"}]) — synthesize from AI research',
            ],
          }) }],
          isError: true,
        };
      }

      const aggregation = aggregateAndRankReddit(results, 3);
      const md = generateRedditEnhancedOutput(aggregation, limited, results);
      return { content: [{ type: 'text', text: md }] };
    } catch (error) {
      const err = classifyError(error);
      return {
        content: [{ type: 'text', text: formatError({
          code: err.code,
          message: err.message,
          retryable: err.retryable,
          toolName: 'search_reddit',
          howToFix: ['Verify SERPER_API_KEY is set correctly'],
          alternatives: [
            'web_search(keywords=["topic recommendations", "topic best practices"]) — uses the same API key, but try anyway as it may work for general search',
            'deep_research(questions=[{question: "What does the community recommend for [topic]?"}]) — uses a different API (OpenRouter)',
          ],
        }) }],
        isError: true,
      };
    }
  },
};
