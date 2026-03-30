/**
 * Scrape Links Tool — scrape URLs with optional LLM extraction
 * NEVER throws — catches all errors and returns ToolResult with isError: true
 */

import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import type { ResolvedEnv } from '../env.js';
import { ScraperClient } from '../clients/scraper.js';
import { OpenRouterClient } from '../clients/openrouter.js';
import { htmlToMarkdown, removeMetaTags } from '../lib/markdown.js';
import { pMap } from '../lib/concurrency.js';
import { formatSuccess, formatError, formatBatchHeader, formatDuration, TOKEN_BUDGET, calculateTokenAllocation } from '../lib/response.js';
import { classifyError } from '../lib/errors.js';

// ── Constants ──

const BATCH_SIZE = 30;

function validateAndPartitionUrls(urls: string[]): { validUrls: string[]; invalidUrls: string[] } {
  const validUrls: string[] = [];
  const invalidUrls: string[] = [];
  for (const url of urls) {
    try {
      new URL(url);
      validUrls.push(url);
    } catch {
      invalidUrls.push(url);
    }
  }
  return { validUrls, invalidUrls };
}

// ── Schema ──

const schema = z.object({
  urls: z.array(z.string()).min(1).max(50)
    .describe('1-50 URLs to scrape'),
  use_llm: z.boolean().optional().default(false)
    .describe('Use LLM to extract specific content from scraped pages'),
  what_to_extract: z.string().optional()
    .describe('Extraction instruction for LLM (when use_llm=true)'),
  timeout: z.number().int().min(5).max(120).optional().default(15)
    .describe('Timeout per URL in seconds (default 15)'),
});

export const scrapeTool: ToolDefinition<typeof schema> = {
  name: 'scrape_links',
  description: 'Scrape 1-50 URLs with 3-mode fallback (basic, JS rendering, JS+geo). Optionally extract specific content via LLM.',
  inputSchema: schema,
  capability: 'scraping',

  async handler(params, env: ResolvedEnv): Promise<ToolResult> {
    const startTime = Date.now();

    if (!params.urls || params.urls.length === 0) {
      return {
        content: [{ type: 'text', text: formatError({
          code: 'NO_URLS', message: 'No URLs provided', toolName: 'scrape_links',
          howToFix: ['Provide at least one valid URL'],
        }) }],
        isError: true,
      };
    }

    const { validUrls, invalidUrls } = validateAndPartitionUrls(params.urls);

    if (validUrls.length === 0) {
      return {
        content: [{ type: 'text', text: formatError({
          code: 'INVALID_URLS', message: `All ${params.urls.length} URLs are invalid`, toolName: 'scrape_links',
          alternatives: [
            'web_search(keywords=["topic documentation", "topic guide"]) — search for valid URLs first',
          ],
        }) }],
        isError: true,
      };
    }

    const tokensPerUrl = calculateTokenAllocation(validUrls.length, TOKEN_BUDGET);
    const totalBatches = Math.ceil(validUrls.length / BATCH_SIZE);

    try {
      const client = new ScraperClient(env.SCRAPEDO_API_KEY!);
      const enhancedInstruction = params.use_llm
        ? `Extract ONLY from document — never hallucinate.\n\n${params.what_to_extract || 'Extract the main content and key information from this page.'}\n\nBe comprehensive but concise. Prioritize actionable insights.`
        : undefined;

      const results = await client.scrapeMultiple(validUrls, { timeout: params.timeout });

      // Process results
      const successItems: { url: string; content: string; index: number }[] = [];
      const failedContents: string[] = [];
      let successful = 0;
      let failed = 0;
      let totalCredits = 0;

      for (const invalidUrl of invalidUrls) {
        failed++;
        failedContents.push(`## ${invalidUrl}\n\nInvalid URL format`);
      }

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (!result) { failed++; continue; }

        if (result.error || result.statusCode < 200 || result.statusCode >= 300) {
          failed++;
          const errorMsg = result.error?.message || result.content || `HTTP ${result.statusCode}`;
          failedContents.push(`## ${result.url}\n\nFailed to scrape: ${errorMsg}`);
          continue;
        }

        successful++;
        totalCredits += result.credits;

        let content: string;
        try {
          content = htmlToMarkdown(result.content);
        } catch {
          content = result.content;
        }

        successItems.push({ url: result.url, content, index: i });
      }

      // Optional LLM extraction
      let llmErrors = 0;
      let processedItems = successItems;
      if (params.use_llm && env.OPENROUTER_API_KEY && successItems.length > 0) {
        const llmClient = new OpenRouterClient(env.OPENROUTER_API_KEY!, {
          extractionModel: env.LLM_EXTRACTION_MODEL,
        });
        const llmResults = await pMap(successItems, async (item) => {
          const llmResult = await llmClient.extract(
            item.content, enhancedInstruction, tokensPerUrl,
          );
          if (llmResult.processed) {
            return { ...item, content: llmResult.content };
            }
            llmErrors++;
            return item;
          }, 3);
          processedItems = llmResults;
      }

      // Assemble output
      const contents = [...failedContents];
      for (const item of processedItems) {
        let content = item.content;
        try { content = removeMetaTags(content); } catch { /* use as-is */ }
        contents.push(`## ${item.url}\n\n${content}`);
      }

      const executionTime = Date.now() - startTime;

      const batchHeader = formatBatchHeader({
        title: `Scraped Content (${params.urls.length} URLs)`,
        totalItems: params.urls.length,
        successful,
        failed,
        tokensPerItem: tokensPerUrl,
        batches: totalBatches,
        extras: {
          'Credits used': totalCredits,
          ...(llmErrors > 0 ? { 'LLM extraction failures': llmErrors } : {}),
        },
      });

      const nextSteps: string[] = [
        successful > 0 ? 'FOLLOW LINKS: If scraped content references other URLs/docs/sources, scrape those too' : null,
        successful > 0 ? 'VERIFY: web_search(keywords=["claim from scraped content", "topic official source"]) — cross-check extracted claims' : null,
        successful > 0 ? 'COMMUNITY: search_reddit(queries=["topic experiences", "topic recommendations"]) — if topic warrants community perspective' : null,
        successful > 0 ? 'SYNTHESIZE (only after verifying + community check): deep_research(questions=[{question: "Based on scraped data and verification..."}])' : null,
        failed > 0 ? `Retry failed URLs with longer timeout: scrape_links(urls=[...], timeout=60)` : null,
      ].filter(Boolean) as string[];

      const md = formatSuccess({
        title: 'Scraping Complete',
        summary: batchHeader,
        data: contents.join('\n\n---\n\n'),
        nextSteps,
        metadata: {
          'Execution time': formatDuration(executionTime),
          'Token budget': TOKEN_BUDGET.toLocaleString(),
        },
      });

      return { content: [{ type: 'text', text: md }] };
    } catch (error) {
      const err = classifyError(error);
      return {
        content: [{ type: 'text', text: formatError({
          code: err.code,
          message: err.message,
          retryable: err.retryable,
          toolName: 'scrape_links',
          howToFix: ['Verify SCRAPEDO_API_KEY is set correctly'],
          alternatives: [
            'web_search(keywords=["topic key findings", "topic summary"]) — search for information instead of scraping',
            'deep_research(questions=[{question: "Summarize the key information from [topic]"}]) — use AI research to gather equivalent information',
          ],
        }) }],
        isError: true,
      };
    }
  },
};
