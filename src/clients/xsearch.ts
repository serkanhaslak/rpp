/**
 * X Search Client
 * Searches X/Twitter posts via OpenRouter using Grok with native x_search plugin.
 * NEVER throws - always returns structured response for graceful degradation.
 */

import OpenAI from 'openai';
import { RESEARCH } from '../config/index.js';
import { calculateBackoff } from '../utils/retry.js';
import { pMapSettled } from '../utils/concurrency.js';
import {
  classifyError,
  sleep,
  ErrorCode,
  withRequestTimeout,
  withStallProtection,
  type StructuredError,
} from '../utils/errors.js';
import { mcpLog } from '../utils/logger.js';
import type { OpenRouterMessage, OpenRouterAnnotation } from './research.js';

// ── Constants ──

const X_SEARCH_MODEL = 'x-ai/grok-4.1-fast' as const;
const MAX_RETRIES = 3 as const;
const BASE_DELAY_MS = 3_000 as const;
const MAX_DELAY_MS = 30_000 as const;
const REQUEST_DEADLINE_MS = 60_000 as const;
const STALL_TIMEOUT_MS = 45_000 as const;
const TEMPERATURE = 0.1 as const;

const SYSTEM_PROMPT = `X search. Per post: @handle (date): text [likes,RTs] URL. All results, by relevance.`;

// ── Interfaces ──

export interface XSearchQuery {
  readonly query: string;
  readonly from_handles?: string[];
  readonly exclude_handles?: string[];
  readonly from_date?: string;
  readonly to_date?: string;
}

export interface XSearchResult {
  readonly query: string;
  readonly content: string;
  readonly annotations: ReadonlyArray<{
    readonly type: string;
    readonly url: string;
    readonly title: string;
  }>;
  readonly usage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
  readonly error?: StructuredError;
}

// ── Client ──

export class XSearchClient {
  private client: OpenAI;

  constructor() {
    if (!RESEARCH.API_KEY) {
      throw new Error('X Search requires OPENROUTER_API_KEY.');
    }
    this.client = new OpenAI({
      baseURL: RESEARCH.BASE_URL,
      apiKey: RESEARCH.API_KEY,
      timeout: 60_000,
      maxRetries: 0,
    });
  }

  async search(params: XSearchQuery): Promise<XSearchResult> {
    const { query, from_handles, exclude_handles, from_date, to_date } = params;

    const payload: Record<string, unknown> = {
      model: X_SEARCH_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
      temperature: TEMPERATURE,
      max_tokens: 2048,
      plugins: [{ id: 'web' }],
    };

    // OpenRouter x_search_filter — handle filtering and date ranges for xAI models
    const xFilter: Record<string, unknown> = {};
    if (from_handles?.length) xFilter.allowed_x_handles = from_handles;
    if (exclude_handles?.length) xFilter.excluded_x_handles = exclude_handles;
    if (from_date) xFilter.from_date = from_date;
    if (to_date) xFilter.to_date = to_date;
    if (Object.keys(xFilter).length > 0) {
      payload.x_search_filter = xFilter;
    }

    let lastError: StructuredError | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          mcpLog('warning', `X search retry ${attempt}/${MAX_RETRIES} for: ${query}`, 'xsearch');
        }

        const response = await withStallProtection(
          (stallSignal) => withRequestTimeout(
            (timeoutSignal) => {
              const merged = new AbortController();
              const abort = () => merged.abort();
              stallSignal.addEventListener('abort', abort, { once: true });
              timeoutSignal.addEventListener('abort', abort, { once: true });

              return this.client.chat.completions.create(
                payload as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
                { signal: merged.signal },
              ).finally(() => {
                stallSignal.removeEventListener('abort', abort);
                timeoutSignal.removeEventListener('abort', abort);
              });
            },
            REQUEST_DEADLINE_MS,
            `xsearch (${query})`,
          ),
          STALL_TIMEOUT_MS,
          2,
          `xsearch (${query})`,
        );

        const choice = response.choices?.[0];
        const message = choice?.message as unknown as OpenRouterMessage;

        if (!message?.content && !choice) {
          lastError = { code: ErrorCode.INTERNAL_ERROR, message: 'X search returned empty response', retryable: true };
          if (attempt < MAX_RETRIES) {
            const delay = calculateBackoff(attempt, BASE_DELAY_MS, MAX_DELAY_MS);
            await sleep(delay);
            continue;
          }
        }

        const annotations = (message?.annotations || []).map((a: OpenRouterAnnotation) => ({
          type: a.type || 'url_citation',
          url: a.url_citation?.url || '',
          title: a.url_citation?.title || '',
        }));

        return {
          query,
          content: message?.content || '',
          annotations,
          usage: response.usage ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          } : undefined,
        };

      } catch (error: unknown) {
        lastError = classifyError(error);
        mcpLog('error', `X search error (attempt ${attempt + 1}): ${lastError.message} (status: ${lastError.statusCode})`, 'xsearch');

        if (lastError.retryable && attempt < MAX_RETRIES) {
          const delay = calculateBackoff(attempt, BASE_DELAY_MS, MAX_DELAY_MS);
          try { await sleep(delay); } catch { break; }
          continue;
        }
        break;
      }
    }

    return {
      query,
      content: '',
      annotations: [],
      error: lastError || { code: ErrorCode.UNKNOWN_ERROR, message: 'Unknown X search error', retryable: false },
    };
  }

  async searchMultiple(queries: XSearchQuery[], concurrency: number = 5): Promise<XSearchResult[]> {
    const results = await pMapSettled(queries, (q) => this.search(q), concurrency);
    return results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : {
            query: queries[i]!.query,
            content: '',
            annotations: [],
            error: classifyError(r.reason),
          }
    );
  }
}
