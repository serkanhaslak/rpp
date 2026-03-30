/**
 * Web Search Tool — parallel Google search with CTR-weighted consensus ranking
 * NEVER throws — catches all errors and returns ToolResult with isError: true
 */

import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import type { ResolvedEnv } from '../env.js';
import { SerperClient } from '../clients/serper.js';
import {
  aggregateAndRank,
  buildUrlLookup,
  lookupUrl,
  generateEnhancedOutput,
  markConsensus,
} from '../lib/url-ranking.js';
import { formatSuccess, formatError, formatDuration } from '../lib/response.js';
import { classifyError } from '../lib/errors.js';

const schema = z.object({
  keywords: z.array(z.string().min(1).max(500)).min(3).max(100)
    .describe('3-100 search keywords. Each becomes a separate Google search.'),
  num_results: z.number().int().min(1).max(100).optional().default(10)
    .describe('Results per keyword (default 10)'),
});

export const webSearchTool: ToolDefinition<typeof schema> = {
  name: 'web_search',
  description: 'Parallel Google search across 3-100 keywords with CTR-weighted consensus ranking. Returns aggregated URLs ranked by cross-query agreement.',
  inputSchema: schema,
  capability: 'search',

  async handler(params, env: ResolvedEnv): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const client = new SerperClient(env.SERPER_API_KEY!);
      const response = await client.searchMultiple(params.keywords, params.num_results);
      const aggregation = aggregateAndRank(response.searches, 5);
      const consensusUrls = aggregation.rankedUrls.filter(u => u.frequency >= aggregation.frequencyThreshold);

      let md = '';
      if (consensusUrls.length > 0) {
        md += generateEnhancedOutput(
          consensusUrls, params.keywords, aggregation.totalUniqueUrls,
          aggregation.frequencyThreshold, aggregation.thresholdNote,
        );
      } else {
        md += `## Search Results (${params.keywords.length} queries)\n\n> No high-consensus URLs found.\n\n`;
      }

      // Per-query results (abbreviated)
      const urlLookup = buildUrlLookup(aggregation.rankedUrls);
      const MAX_QUERIES = 15;
      const queriesToShow = response.searches.slice(0, MAX_QUERIES);
      md += '\n## Full Search Results by Query\n\n';
      let totalResults = 0;
      for (let i = 0; i < queriesToShow.length; i++) {
        const search = queriesToShow[i]!;
        md += `### Query ${i + 1}: "${search.keyword}"\n\n`;
        const maxResults = response.totalKeywords > 10 ? 5 : 10;
        for (let j = 0; j < Math.min(search.results.length, maxResults); j++) {
          const r = search.results[j]!;
          const ranked = lookupUrl(r.link, urlLookup);
          const freq = ranked?.frequency ?? 1;
          md += `${j + 1}. **[${r.title}](${r.link})** — ${markConsensus(freq)} (${freq} searches)\n`;
          if (r.snippet) {
            const snip = r.snippet.length > 150 ? r.snippet.substring(0, 147) + '...' : r.snippet;
            md += `   - ${r.date ? `*${r.date}* — ` : ''}${snip}\n`;
          }
          md += '\n';
          totalResults++;
        }
        if (i < queriesToShow.length - 1) md += '---\n\n';
      }

      const topUrls = (consensusUrls.length > 0 ? consensusUrls : aggregation.rankedUrls)
        .slice(0, 5).map(u => `"${u.url}"`).join(', ');

      md += '\n\n---\n\n**Next Steps (DO ALL — research is a loop, not a single call):**\n';
      md += `1. MUST DO: scrape_links(urls=[${topUrls}], use_llm=true, what_to_extract="Extract key findings | recommendations | data | evidence | comparisons") — searching only gives URLs, scraping gets the actual content\n`;
      md += '2. COMMUNITY CHECK: search_reddit(queries=["topic recommendations", "topic best 2025", "topic vs alternatives"]) — get real user experiences\n';
      md += '3. ITERATE: If results are insufficient, search again with different keywords from "Related" suggestions above\n';
      md += '4. SYNTHESIZE (only after scraping + Reddit): deep_research(questions=[{question: "Based on scraped content and community feedback..."}])\n';

      md += `\n---\n*${formatDuration(Date.now() - startTime)} | ${aggregation.totalUniqueUrls} unique URLs | ${consensusUrls.length} consensus*`;

      return { content: [{ type: 'text', text: md }] };
    } catch (error) {
      const err = classifyError(error);
      return {
        content: [{ type: 'text', text: formatError({
          code: err.code,
          message: err.message,
          retryable: err.retryable,
          toolName: 'web_search',
          howToFix: ['Verify SERPER_API_KEY is set'],
          alternatives: [
            'search_reddit(queries=["topic recommendations", "topic best practices"]) — Reddit search uses the same API but may work',
            'deep_research(questions=[{question: "What are the key findings about [topic]?"}]) — uses OpenRouter API (different key)',
          ],
        }) }],
        isError: true,
      };
    }
  },
};
