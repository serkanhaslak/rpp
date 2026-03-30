/**
 * Reddit Post Tool — fetch full Reddit posts with comments via Reddit OAuth API
 * NEVER throws — catches all errors and returns ToolResult with isError: true
 */

import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import type { ResolvedEnv } from '../env.js';
import {
  RedditClient,
  calculateCommentAllocation,
  COMMENT_SORTS,
  type PostResult,
  type Comment,
} from '../clients/reddit.js';
import { OpenRouterClient } from '../clients/openrouter.js';
import { pMap } from '../lib/concurrency.js';
import { formatSuccess, formatError, formatBatchHeader, TOKEN_BUDGET } from '../lib/response.js';
import { classifyError } from '../lib/errors.js';

// ── Constants ──

const MIN_POSTS = 2;
const MAX_POSTS = 50;
const BATCH_SIZE = 10;

// ── Formatters ──

function formatComments(comments: Comment[]): string {
  let md = '';
  for (const c of comments) {
    const indent = '  '.repeat(c.depth);
    const op = c.isOP ? ' **[OP]**' : '';
    const score = c.score >= 0 ? `+${c.score}` : `${c.score}`;
    md += `${indent}- **u/${c.author}**${op} _(${score})_\n`;
    const bodyLines = c.body.split('\n').map(line => `${indent}  ${line}`).join('\n');
    md += `${bodyLines}\n\n`;
  }
  return md;
}

function formatPost(result: PostResult, fetchComments: boolean): string {
  const { post, comments, allocatedComments } = result;
  let md = `## ${post.title}\n\n`;
  md += `**r/${post.subreddit}** | u/${post.author} | ${post.score} points | ${post.commentCount} comments\n`;
  md += `${post.url}\n\n`;

  if (post.body) {
    md += `### Post Content\n\n${post.body}\n\n`;
  }

  if (fetchComments && comments.length > 0) {
    md += `### Top Comments (${comments.length}/${post.commentCount} shown, allocated: ${allocatedComments})\n\n`;
    md += formatComments(comments);
  } else if (!fetchComments) {
    md += `_Comments not fetched (fetch_comments=false)_\n\n`;
  }

  return md;
}

// ── Schema ──

const schema = z.object({
  urls: z.array(z.string().url()).min(2).max(50)
    .describe('2-50 Reddit post URLs to fetch'),
  fetch_comments: z.boolean().optional().default(true)
    .describe('Whether to fetch comments (default true)'),
  max_comments: z.number().int().min(1).max(500).optional().default(100)
    .describe('Maximum comments per post (default 100)'),
  sort: z.enum(COMMENT_SORTS).optional().default('top')
    .describe('Comment sort order (default "top")'),
  use_llm: z.boolean().optional().default(false)
    .describe('Use LLM to extract insights from posts'),
  what_to_extract: z.string().optional()
    .describe('Extraction instruction for LLM (when use_llm=true)'),
});

export const redditPostTool: ToolDefinition<typeof schema> = {
  name: 'get_reddit_post',
  description: 'Fetch full Reddit posts with comments via Reddit OAuth API. Supports LLM-powered extraction of key insights from discussions.',
  inputSchema: schema,
  capability: 'reddit',

  async handler(params, env: ResolvedEnv): Promise<ToolResult> {
    try {
      const { urls, fetch_comments, max_comments, sort, use_llm, what_to_extract } = params;

      // Validate post count
      if (urls.length < MIN_POSTS) {
        return {
          content: [{ type: 'text', text: formatError({
            code: 'MIN_POSTS',
            message: `Minimum ${MIN_POSTS} Reddit posts required. Received: ${urls.length}`,
            toolName: 'get_reddit_post',
            howToFix: [`Add at least ${MIN_POSTS - urls.length} more Reddit URL(s)`],
            alternatives: [
              `search_reddit(queries=["topic discussion", "topic recommendations"]) — find more Reddit posts first`,
            ],
          }) }],
          isError: true,
        };
      }
      if (urls.length > MAX_POSTS) {
        return {
          content: [{ type: 'text', text: formatError({
            code: 'MAX_POSTS',
            message: `Maximum ${MAX_POSTS} Reddit posts allowed. Received: ${urls.length}`,
            toolName: 'get_reddit_post',
            howToFix: [`Remove ${urls.length - MAX_POSTS} URL(s) and retry`],
          }) }],
          isError: true,
        };
      }

      const allocation = calculateCommentAllocation(urls.length);
      const commentsPerPost = fetch_comments ? (max_comments || allocation.perPostCapped) : 0;
      const totalBatches = Math.ceil(urls.length / BATCH_SIZE);

      const client = new RedditClient(env.REDDIT_CLIENT_ID!, env.REDDIT_CLIENT_SECRET!);
      const batchResult = await client.batchGetPosts(urls, commentsPerPost, fetch_comments, undefined, sort);

      // Process results
      let successful = 0;
      let failed = 0;
      let llmErrors = 0;
      const failedContents: string[] = [];
      const successEntries: { url: string; result: PostResult; content: string }[] = [];

      for (const [url, result] of batchResult.results) {
        if (result instanceof Error) {
          failed++;
          failedContents.push(`## Failed: ${url}\n\n_${result.message}_`);
          continue;
        }
        successful++;
        successEntries.push({ url, result, content: formatPost(result, fetch_comments) });
      }

      // Optional LLM extraction
      let processedEntries = successEntries;
      if (use_llm && env.OPENROUTER_API_KEY && successEntries.length > 0) {
        const tokensPerUrl = Math.floor(TOKEN_BUDGET / urls.length);
        const enhancedInstruction = (what_to_extract || 'Extract key insights, recommendations, and community consensus from these Reddit discussions.')
          + '\n\n---\nExtract and synthesize the key insights, opinions, and recommendations. Focus on common themes, specific recommendations, contrasting viewpoints, and real-world experiences.';

        const llmClient = new OpenRouterClient(env.OPENROUTER_API_KEY!, {
          extractionModel: env.LLM_EXTRACTION_MODEL,
        });
        const llmResults = await pMap(successEntries, async (entry) => {
          const llmResult = await llmClient.extract(
            entry.content, enhancedInstruction, tokensPerUrl,
          );
          if (llmResult.processed) {
            const header = `## LLM Analysis: ${entry.result.post.title}\n\n**r/${entry.result.post.subreddit}** | u/${entry.result.post.author} | ${entry.result.post.score} points | ${entry.result.post.commentCount} comments\n${entry.result.post.url}\n\n`;
            return { ...entry, content: header + llmResult.content };
          }
          llmErrors++;
          return entry;
        }, 3);
        processedEntries = llmResults;
      }

      const contents = [...failedContents, ...processedEntries.map(e => e.content)];
      const tokensPerUrl = use_llm ? Math.floor(TOKEN_BUDGET / urls.length) : 0;

      const batchHeader = formatBatchHeader({
        title: `Reddit Posts`,
        totalItems: urls.length,
        successful,
        failed,
        ...(fetch_comments ? { extras: { 'Comments/post': commentsPerPost } } : {}),
        ...(use_llm ? { tokensPerItem: tokensPerUrl } : {}),
        batches: totalBatches,
      });

      const extras: string[] = [];
      if (batchResult.rateLimitHits > 0) extras.push(`${batchResult.rateLimitHits} rate limit retries`);
      if (llmErrors > 0) extras.push(`${llmErrors} LLM extraction failures`);
      const extraStatus = extras.length > 0 ? `\n${extras.join(' | ')}` : '';

      const nextSteps: string[] = [
        successful > 0 ? 'VERIFY CLAIMS: web_search(keywords=["topic claim1 verify", "topic best practices"]) — community says X, verify with web' : null,
        successful > 0 ? 'SCRAPE REFERENCED LINKS: scrape_links(urls=[...URLs found in comments...], use_llm=true) — follow external links from discussions' : null,
        'BROADEN: search_reddit(queries=[...related angles...]) — if more perspectives needed',
        successful > 0 ? 'SYNTHESIZE (only after verifying + scraping): deep_research(questions=[{question: "Based on verified Reddit findings about [topic]..."}])' : null,
        failed > 0 ? 'Retry failed URLs individually' : null,
      ].filter(Boolean) as string[];

      const md = formatSuccess({
        title: `Reddit Posts Fetched (${successful}/${urls.length})`,
        summary: batchHeader + extraStatus,
        data: contents.join('\n\n---\n\n'),
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
          toolName: 'get_reddit_post',
          howToFix: ['Verify REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are set'],
          alternatives: [
            'web_search(keywords=["topic reddit discussion"]) — search for Reddit content via web search instead',
            'scrape_links(urls=[...the Reddit URLs...], use_llm=true) — scrape Reddit pages directly as a fallback',
          ],
        }) }],
        isError: true,
      };
    }
  },
};
