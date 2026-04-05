/**
 * Unified OpenRouter LLM client — research, extraction, and X search
 *
 * Merges the former ResearchClient + LLM processor + XSearchClient into
 * a single class that accepts API key in constructor and uses no process.env.
 *
 * Cloudflare Workers compatible — no Node-only APIs, no config imports.
 */

import OpenAI from 'openai';
import { pMapSettled } from '../lib/concurrency.js';
import {
  classifyError,
  sleep,
  ErrorCode,
  calculateBackoff,
  withRequestTimeout,
  withStallProtection,
  type StructuredError,
} from '../lib/errors.js';

// ── Constants ──

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const MAX_RESEARCH_RETRIES = 3;
const RESEARCH_TEMPERATURE = 0.3;
const RESEARCH_BASE_DELAY_MS = 5000;
const RESEARCH_MAX_DELAY_MS = 60000;
const DEFAULT_MAX_TOKENS = 32000;
const MAX_SEARCH_RESULTS_CAP = 30;
const RESEARCH_REQUEST_DEADLINE_MS = 120000;
const RESEARCH_STALL_TIMEOUT_MS = 90000;

const LLM_STALL_TIMEOUT_MS = 15000;
const LLM_REQUEST_DEADLINE_MS = 30000;
const LLM_MAX_RETRIES = 2;
const MAX_LLM_INPUT_CHARS = 100000;

const X_SEARCH_MODEL_DEFAULT = 'x-ai/grok-4.1-fast';
const X_SEARCH_TEMPERATURE = 0.1;
const X_SYSTEM_PROMPT = 'X search. Per post: @handle (date): text [likes,RTs] URL. All results, by relevance.';

const GEMINI_STYLE_MODELS = new Set([
  'google/gemini-2.5-flash', 'google/gemini-2.5-pro',
  'google/gemini-2.0-flash', 'google/gemini-pro',
]);

function isGeminiStyleModel(model: string): boolean {
  return GEMINI_STYLE_MODELS.has(model) || model.startsWith('google/gemini');
}

// ── Interfaces ──

export interface OpenRouterMessage {
  readonly role: string;
  readonly content: string | null;
  readonly annotations?: readonly OpenRouterAnnotation[];
}

export interface OpenRouterAnnotation {
  readonly type: string;
  readonly url_citation?: {
    readonly url: string;
    readonly title?: string;
    readonly start_index?: number;
    readonly end_index?: number;
  };
  readonly [key: string]: unknown;
}

export interface ResearchResponse {
  readonly id: string;
  readonly model: string;
  readonly created: number;
  readonly content: string;
  readonly finishReason?: string;
  readonly usage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
    readonly sourcesUsed?: number;
  };
  readonly annotations?: ReadonlyArray<{
    readonly type: 'url_citation';
    readonly url: string;
    readonly title: string;
    readonly startIndex: number;
    readonly endIndex: number;
  }>;
  readonly error?: StructuredError;
}

export interface ResearchParams {
  readonly question: string;
  readonly systemPrompt?: string;
  readonly reasoningEffort?: 'low' | 'medium' | 'high';
  readonly maxSearchResults?: number;
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** When true, skip web search — use for grounded synthesis over pre-fetched content */
  readonly disableSearch?: boolean;
}

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

export interface LLMExtractionResult {
  readonly content: string;
  readonly processed: boolean;
  readonly error?: string;
}

export interface OpenRouterOptions {
  baseUrl?: string;
  model?: string;
  fallbackModel?: string;
  extractionModel?: string;
  timeout?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  maxUrls?: number;
}

// ── Client ──

export class OpenRouterClient {
  private client: OpenAI;
  private model: string;
  private fallbackModel: string;
  private extractionModel: string;
  private reasoningEffort: 'low' | 'medium' | 'high';
  private maxUrls: number;

  constructor(
    private apiKey: string,
    private options: OpenRouterOptions = {},
  ) {
    this.client = new OpenAI({
      baseURL: options.baseUrl || DEFAULT_BASE_URL,
      apiKey,
      timeout: options.timeout || 120000,
      maxRetries: 0,
    });
    this.model = options.model || 'x-ai/grok-4.1-fast';
    this.fallbackModel = options.fallbackModel || 'google/gemini-2.5-flash';
    this.extractionModel = options.extractionModel || 'minimax/minimax-m2.7';
    this.reasoningEffort = options.reasoningEffort || 'high';
    this.maxUrls = options.maxUrls || 100;
  }

  // ── Research ──

  async research(params: ResearchParams, signal?: AbortSignal): Promise<ResearchResponse> {
    const { question, systemPrompt, reasoningEffort = this.reasoningEffort,
            maxSearchResults = this.maxUrls, maxTokens = DEFAULT_MAX_TOKENS,
            temperature = RESEARCH_TEMPERATURE } = params;

    if (!question?.trim()) {
      return { id: '', model: this.model, created: Date.now(), content: '',
        error: { code: ErrorCode.INVALID_INPUT, message: 'Research question cannot be empty', retryable: false } };
    }

    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: question });

    const opts = { temperature, reasoningEffort, maxTokens, maxSearchResults, disableSearch: params.disableSearch };

    // Try primary model
    const primaryResult = await this.executeResearch(this.model, messages, opts, signal);
    if (!primaryResult.error) return primaryResult;

    // Try fallback
    if (this.fallbackModel && this.fallbackModel !== this.model) {
      console.warn(`Primary model failed, trying fallback: ${this.fallbackModel}`);
      const fallbackResult = await this.executeResearch(this.fallbackModel, messages, opts, signal);
      if (!fallbackResult.error) return fallbackResult;
      return { ...fallbackResult,
        content: `Research failed with both models. Primary: ${primaryResult.error?.message}. Fallback: ${fallbackResult.error?.message}` };
    }

    return { ...primaryResult, content: `Research failed: ${primaryResult.error?.message}` };
  }

  private async executeResearch(
    model: string,
    messages: ReadonlyArray<{ role: 'system' | 'user'; content: string }>,
    opts: { temperature: number; reasoningEffort: string; maxTokens: number; maxSearchResults: number; disableSearch?: boolean },
    signal?: AbortSignal,
  ): Promise<ResearchResponse> {
    const payload = this.buildResearchPayload(model, messages, opts);
    let lastError: StructuredError | undefined;

    for (let attempt = 0; attempt <= MAX_RESEARCH_RETRIES; attempt++) {
      try {
        if (attempt > 0) console.warn(`Research retry ${attempt}/${MAX_RESEARCH_RETRIES} for ${model}`);

        const response = await withStallProtection(
          (stallSignal) => withRequestTimeout(
            (timeoutSignal) => {
              const merged = new AbortController();
              const abort = () => merged.abort();
              signal?.addEventListener('abort', abort, { once: true });
              stallSignal.addEventListener('abort', abort, { once: true });
              timeoutSignal.addEventListener('abort', abort, { once: true });
              return this.client.chat.completions.create(
                payload as any, { signal: merged.signal }
              ).finally(() => {
                signal?.removeEventListener('abort', abort);
                stallSignal.removeEventListener('abort', abort);
                timeoutSignal.removeEventListener('abort', abort);
              });
            },
            RESEARCH_REQUEST_DEADLINE_MS, `research (${model})`
          ),
          RESEARCH_STALL_TIMEOUT_MS, 2, `research (${model})`
        );

        const choice = response.choices?.[0];
        const message = choice?.message as unknown as OpenRouterMessage;

        if (!message?.content && !choice) {
          lastError = { code: ErrorCode.INTERNAL_ERROR, message: 'Empty response', retryable: true };
          if (attempt < MAX_RESEARCH_RETRIES) {
            await sleep(calculateBackoff(attempt, RESEARCH_BASE_DELAY_MS, RESEARCH_MAX_DELAY_MS), signal);
            continue;
          }
        }

        return {
          id: response.id || '',
          model: response.model || model,
          created: response.created || Date.now(),
          content: message?.content || '',
          finishReason: choice?.finish_reason ?? undefined,
          usage: response.usage ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          } : undefined,
          annotations: message?.annotations?.map((a) => ({
            type: 'url_citation' as const,
            url: a.url_citation?.url || '',
            title: a.url_citation?.title || '',
            startIndex: a.url_citation?.start_index || 0,
            endIndex: a.url_citation?.end_index || 0,
          })),
        };
      } catch (error) {
        lastError = classifyError(error);
        if (this.isRetryableError(error) && attempt < MAX_RESEARCH_RETRIES) {
          const delay = calculateBackoff(attempt, RESEARCH_BASE_DELAY_MS, RESEARCH_MAX_DELAY_MS);
          try { await sleep(delay, signal); } catch { break; }
          continue;
        }
        break;
      }
    }
    return { id: '', model, created: Date.now(), content: '',
      error: lastError || { code: ErrorCode.UNKNOWN_ERROR, message: 'Unknown error', retryable: false } };
  }

  private buildResearchPayload(
    model: string,
    messages: ReadonlyArray<{ role: string; content: string }>,
    opts: { temperature: number; reasoningEffort: string; maxTokens: number; maxSearchResults: number; disableSearch?: boolean },
  ): Record<string, unknown> {
    // When disableSearch is true, skip web search (for grounded synthesis over pre-fetched content)
    if (opts.disableSearch) {
      return { model, messages, temperature: opts.temperature,
        max_completion_tokens: opts.maxTokens };
    }
    if (isGeminiStyleModel(model)) {
      return { model, messages, temperature: opts.temperature, max_tokens: opts.maxTokens,
        tools: [{ type: 'google_search', googleSearch: {} }] };
    }
    return { model, messages, temperature: opts.temperature,
      reasoning_effort: opts.reasoningEffort,
      max_completion_tokens: opts.maxTokens,
      search_parameters: {
        mode: 'on',
        max_search_results: Math.min(opts.maxSearchResults, MAX_SEARCH_RESULTS_CAP),
        return_citations: true, sources: [{ type: 'web' }],
      } };
  }

  // ── X Search ──

  async xSearch(params: XSearchQuery): Promise<XSearchResult> {
    const payload: Record<string, unknown> = {
      model: X_SEARCH_MODEL_DEFAULT,
      messages: [{ role: 'system', content: X_SYSTEM_PROMPT }, { role: 'user', content: params.query }],
      temperature: X_SEARCH_TEMPERATURE, max_tokens: 2048,
      plugins: [{ id: 'web' }],
    };

    const xFilter: Record<string, unknown> = {};
    if (params.from_handles?.length) xFilter.allowed_x_handles = params.from_handles;
    if (params.exclude_handles?.length) xFilter.excluded_x_handles = params.exclude_handles;
    if (params.from_date) xFilter.from_date = params.from_date;
    if (params.to_date) xFilter.to_date = params.to_date;
    if (Object.keys(xFilter).length > 0) payload.x_search_filter = xFilter;

    let lastError: StructuredError | undefined;
    for (let attempt = 0; attempt <= MAX_RESEARCH_RETRIES; attempt++) {
      try {
        if (attempt > 0) console.warn(`X search retry ${attempt}`);
        const response = await withStallProtection(
          (stallSignal) => withRequestTimeout(
            (timeoutSignal) => {
              const merged = new AbortController();
              const abort = () => merged.abort();
              stallSignal.addEventListener('abort', abort, { once: true });
              timeoutSignal.addEventListener('abort', abort, { once: true });
              return this.client.chat.completions.create(payload as any, { signal: merged.signal }).finally(() => {
                stallSignal.removeEventListener('abort', abort);
                timeoutSignal.removeEventListener('abort', abort);
              });
            }, 60000, `xsearch (${params.query})`
          ), 45000, 2, `xsearch (${params.query})`
        );

        const choice = response.choices?.[0];
        const message = choice?.message as unknown as OpenRouterMessage;
        const annotations = (message?.annotations || []).map((a) => ({
          type: a.type || 'url_citation', url: a.url_citation?.url || '', title: a.url_citation?.title || '',
        }));
        return { query: params.query, content: message?.content || '', annotations,
          usage: response.usage ? { promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens, totalTokens: response.usage.total_tokens } : undefined };
      } catch (error) {
        lastError = classifyError(error);
        if (lastError.retryable && attempt < MAX_RESEARCH_RETRIES) {
          const delay = calculateBackoff(attempt, 3000, 30000);
          try { await sleep(delay); } catch { break; }
          continue;
        }
        break;
      }
    }
    return { query: params.query, content: '', annotations: [],
      error: lastError || { code: ErrorCode.UNKNOWN_ERROR, message: 'Unknown error', retryable: false } };
  }

  async xSearchMultiple(queries: XSearchQuery[], concurrency = 5): Promise<XSearchResult[]> {
    const results = await pMapSettled(queries, (q) => this.xSearch(q), concurrency);
    return results.map((r, i) => r.status === 'fulfilled' ? r.value : {
      query: queries[i]!.query, content: '', annotations: [], error: classifyError(r.reason) });
  }

  // ── LLM Extraction ──

  async extract(content: string, instruction?: string, maxTokens?: number): Promise<LLMExtractionResult> {
    if (!content?.trim()) return { content: content || '', processed: false, error: 'Empty content' };

    const truncated = content.length > MAX_LLM_INPUT_CHARS
      ? content.substring(0, MAX_LLM_INPUT_CHARS) + '\n\n[Content truncated]'
      : content;

    const prompt = instruction
      ? `Extract and clean the following content. Focus on: ${instruction}\n\nContent:\n${truncated}`
      : `Clean and extract the main content:\n\n${truncated}`;

    const requestBody: Record<string, unknown> = {
      model: this.extractionModel,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens || 8000,
    };

    let lastError: StructuredError | undefined;
    for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
      try {
        const response = await withStallProtection(
          (stallSignal) => withRequestTimeout(
            (timeoutSignal) => {
              const merged = new AbortController();
              const abort = () => merged.abort();
              stallSignal.addEventListener('abort', abort, { once: true });
              timeoutSignal.addEventListener('abort', abort, { once: true });
              return this.client.chat.completions.create(requestBody as any, { signal: merged.signal }).finally(() => {
                stallSignal.removeEventListener('abort', abort);
                timeoutSignal.removeEventListener('abort', abort);
              });
            }, LLM_REQUEST_DEADLINE_MS, 'LLM extraction'
          ), LLM_STALL_TIMEOUT_MS, 3, 'LLM extraction'
        );

        const result = response.choices?.[0]?.message?.content;
        if (result?.trim()) return { content: result, processed: true };
        return { content, processed: false, error: 'LLM returned empty response' };
      } catch (err) {
        lastError = classifyError(err);
        if (this.isRetryableError(err) && attempt < LLM_MAX_RETRIES) {
          const delay = calculateBackoff(attempt, 1000, 5000);
          try { await sleep(delay); } catch { break; }
          continue;
        }
        break;
      }
    }
    return { content, processed: false, error: `LLM extraction failed: ${lastError?.message || 'Unknown'}` };
  }

  private isRetryableError(error: unknown): boolean {
    if (!error) return false;
    const err = error as any;
    if (err.status && [429, 500, 502, 503, 504].includes(err.status)) return true;
    if (err.code === 'ESTALLED' || err.code === 'ETIMEDOUT') return true;
    const message = (err.message || '').toLowerCase();
    return message.includes('rate limit') || message.includes('timeout') || message.includes('timed out') || message.includes('connection') || message.includes('stalled');
  }
}
