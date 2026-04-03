/**
 * Deep Research Tool — Multi-stage RAG pipeline with fallback to LLM web search
 *
 * When Serper + Scraper APIs are available:
 *   1. Generate search queries from research question (LLM)
 *   2. Search via Serper (parallel, up to 100 results)
 *   3. Scrape top URLs via Scraper (3-mode fallback)
 *   4. Extract key content from scraped pages (Workers AI / OpenRouter)
 *   5. Synthesize answer grounded in actual source content (LLM, no web search)
 *
 * Fallback: Uses OpenRouter's built-in web search when APIs unavailable.
 * NEVER throws — catches all errors and returns ToolResult with isError: true
 */

import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import type { ResolvedEnv } from '../env.js';
import { OpenRouterClient, type ResearchResponse } from '../clients/openrouter.js';
import { SerperClient } from '../clients/serper.js';
import { ScraperClient } from '../clients/scraper.js';
import { extractContent } from '../lib/extraction.js';
import { htmlToMarkdown } from '../lib/markdown.js';
import { aggregateAndRank } from '../lib/url-ranking.js';
import { pMap } from '../lib/concurrency.js';
import { formatSuccess, formatError, formatBatchHeader, formatDuration, truncateText, TOKEN_BUDGET } from '../lib/response.js';
import { classifyError } from '../lib/errors.js';

// ── Constants ──

const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 10;
const RAG_TOP_URLS = 10;
const RAG_SCRAPE_TIMEOUT = 15;
const RAG_SEARCH_QUERIES = 5;
const RAG_RESULTS_PER_QUERY = 10;
const RAG_EXTRACT_CONCURRENCY = 3;
const RAG_MAX_CONTENT_PER_SOURCE = 8000;
const RAG_MAX_CONTEXT_CHARS = 80000;

const SYSTEM_PROMPT = `Expert research engine. Multi-source: docs, papers, blogs, case studies. Cite inline [source].

FORMAT RULES:
- For comparisons/features/structured data -> use markdown table |Col|Col|Col|
- For narrative/diagnostic/explanation -> tight numbered bullets, no prose paragraphs
- No intro, no greeting, no conclusion, no meta-commentary
- No filler phrases: "it is worth noting", "overall", "in conclusion", "importantly"
- Every sentence = fact, data point, or actionable insight
- First line of output = content (never a preamble)`;

const SYNTHESIS_SYSTEM_PROMPT = `Expert research synthesizer. You have been given pre-verified source material scraped from the web. Your job is to synthesize a comprehensive, accurate answer GROUNDED in the provided sources.

RULES:
- ONLY use information from the provided sources — do not hallucinate or add information not in the sources
- Cite sources by their URL in brackets, e.g. [https://example.com]
- For comparisons/features/structured data -> use markdown table
- For narrative/explanation -> tight numbered bullets
- Every sentence = fact, data point, or actionable insight from the sources
- Start immediately with content — no preamble
- If sources conflict, note the disagreement and cite both sides`;

const RESEARCH_SUFFIX = `IMPORTANT: Be information-dense. No filler. Every sentence must contain a fact, data point, or actionable insight.
If comparing options, use a markdown table. Cite sources inline [source].
Start immediately with content — no preamble or meta-commentary.`;

const QUERY_GEN_PROMPT = `Generate exactly {count} diverse Google search queries to thoroughly research the following question. Each query should target a different angle (e.g., official docs, comparisons, tutorials, recent news, community discussions).

Return ONLY the queries, one per line. No numbering, no explanations.

Question: {question}`;

// ── Internal types ──

interface Citation {
  url: string;
  title: string;
}

interface QuestionResult {
  question: string;
  content: string;
  success: boolean;
  error?: string;
  tokensUsed?: number;
  citations?: Citation[];
  pipeline?: 'rag' | 'fallback';
}

interface RAGSource {
  url: string;
  content: string;
}

// ── Schema ──

const schema = z.object({
  questions: z.array(z.object({
    question: z.string().min(10)
      .describe('Research question (minimum 10 characters). Be specific and detailed.'),
    file_attachments: z.array(z.object({
      path: z.string(),
      start_line: z.number().optional(),
      end_line: z.number().optional(),
    })).optional()
      .describe('File attachments (NOT supported in Workers — will be ignored with a warning)'),
  })).min(1).max(10)
    .describe('1-10 research questions to investigate'),
});

export const deepResearchTool: ToolDefinition<typeof schema> = {
  name: 'deep_research',
  description: 'AI-powered deep research synthesis. Sends 1-10 research questions to an LLM with web search capabilities for comprehensive, cited answers.',
  inputSchema: schema,
  capability: 'deepResearch',

  async handler(params, env: ResolvedEnv): Promise<ToolResult> {
    const startTime = Date.now();
    const questions = params.questions || [];

    if (questions.length < MIN_QUESTIONS) {
      return {
        content: [{ type: 'text', text: formatError({
          code: 'MIN_QUESTIONS',
          message: `Minimum ${MIN_QUESTIONS} research question(s) required. Received: ${questions.length}`,
          toolName: 'deep_research',
          howToFix: ['Add at least one question with detailed context'],
        }) }],
        isError: true,
      };
    }
    if (questions.length > MAX_QUESTIONS) {
      return {
        content: [{ type: 'text', text: formatError({
          code: 'MAX_QUESTIONS',
          message: `Maximum ${MAX_QUESTIONS} research questions allowed. Received: ${questions.length}`,
          toolName: 'deep_research',
          howToFix: [`Remove ${questions.length - MAX_QUESTIONS} question(s)`],
        }) }],
        isError: true,
      };
    }

    const tokensPerQuestion = Math.floor(TOKEN_BUDGET / questions.length);

    let client: OpenRouterClient;
    try {
      client = new OpenRouterClient(env.OPENROUTER_API_KEY!, {
        model: env.RESEARCH_MODEL,
        fallbackModel: env.RESEARCH_FALLBACK_MODEL,
        extractionModel: env.LLM_EXTRACTION_MODEL,
        reasoningEffort: (env.DEFAULT_REASONING_EFFORT as 'low' | 'medium' | 'high') || 'high',
        maxUrls: env.DEFAULT_MAX_URLS ? parseInt(env.DEFAULT_MAX_URLS, 10) : 100,
      });
    } catch (error) {
      const err = classifyError(error);
      return {
        content: [{ type: 'text', text: formatError({
          code: 'CLIENT_INIT_FAILED',
          message: `Failed to initialize research client: ${err.message}`,
          toolName: 'deep_research',
          howToFix: ['Check OPENROUTER_API_KEY is set'],
        }) }],
        isError: true,
      };
    }

    // Determine pipeline: RAG (when Serper + Scraper available) or fallback (OpenRouter web search)
    const canRAG = !!env.SERPER_API_KEY && !!env.SCRAPEDO_API_KEY;

    const results = await pMap(questions, async (q, index): Promise<QuestionResult> => {
      try {
        let enhancedQuestion = q.question;
        if (q.file_attachments && q.file_attachments.length > 0) {
          enhancedQuestion += '\n\n[Note: File attachments are not supported in the Workers environment and have been ignored.]';
        }

        if (canRAG) {
          return await executeRAGPipeline(enhancedQuestion, env, client, tokensPerQuestion);
        }
        return await executeFallbackPipeline(enhancedQuestion, env, client, tokensPerQuestion);
      } catch (error) {
        const structuredError = classifyError(error);
        return { question: q.question, content: '', success: false, error: structuredError.message };
      }
    }, 3);

    const executionTime = Date.now() - startTime;
    const successfulResults = results.filter(r => r.success);
    const failedResults = results.filter(r => !r.success);
    const totalTokens = successfulResults.reduce((sum, r) => sum + (r.tokensUsed || 0), 0);
    const ragCount = successfulResults.filter(r => r.pipeline === 'rag').length;
    const fallbackCount = successfulResults.filter(r => r.pipeline === 'fallback').length;

    const batchHeader = formatBatchHeader({
      title: `Deep Research Results`,
      totalItems: questions.length,
      successful: successfulResults.length,
      failed: failedResults.length,
      tokensPerItem: tokensPerQuestion,
      extras: {
        'Total tokens used': totalTokens.toLocaleString(),
        ...(ragCount > 0 ? { 'RAG pipeline': `${ragCount} question(s)` } : {}),
        ...(fallbackCount > 0 ? { 'LLM web search fallback': `${fallbackCount} question(s)` } : {}),
      },
    });

    const sections: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r) continue;
      const preview = truncateText(r.question, 100);
      sections.push(`## Question ${i + 1}: ${preview}\n`);

      if (r.success) {
        sections.push(r.content);
        if (r.citations && r.citations.length > 0) {
          sections.push('\n### Sources Cited\n');
          for (const c of r.citations) {
            const label = c.title || c.url;
            sections.push(`- [${label}](${c.url})`);
          }
        }
        if (r.tokensUsed) sections.push(`\n*Tokens used: ${r.tokensUsed.toLocaleString()}*`);
      } else {
        sections.push(`**Error:** ${r.error}`);
      }
      sections.push('\n---\n');
    }

    const allCitations: Citation[] = [];
    const seenUrls = new Set<string>();
    for (const r of successfulResults) {
      if (r.citations) {
        for (const c of r.citations) {
          if (!seenUrls.has(c.url)) {
            seenUrls.add(c.url);
            allCitations.push(c);
          }
        }
      }
    }

    const citedUrlsSample = allCitations.slice(0, 5).map(c => `"${c.url}"`).join(', ');
    const scrapeStep = allCitations.length > 0
      ? `SCRAPE CITED SOURCES: scrape_links(urls=[${citedUrlsSample}], use_llm=true) — verify ${allCitations.length} research citation(s) with primary sources`
      : 'SCRAPE CITED SOURCES: scrape_links(urls=[...URLs cited in research above...], use_llm=true) — verify research citations with primary sources';

    const nextSteps: string[] = [
      successfulResults.length > 0 ? scrapeStep : null,
      successfulResults.length > 0 ? 'COMMUNITY VALIDATION: search_reddit(queries=["topic findings", "topic real experience"]) — check if community agrees' : null,
      successfulResults.length > 0 ? 'ITERATE: If research revealed gaps, run deep_research again with refined questions' : null,
      successfulResults.length > 0 ? 'WEB VERIFY: web_search(keywords=["specific claim from research"]) — if claims need independent verification' : null,
      failedResults.length > 0 ? 'Retry failed questions with more specific context' : null,
    ].filter(Boolean) as string[];

    const md = formatSuccess({
      title: `Research Complete (${successfulResults.length}/${questions.length})`,
      summary: batchHeader,
      data: sections.join('\n'),
      nextSteps,
      metadata: {
        'Execution time': formatDuration(executionTime),
        'Token budget': TOKEN_BUDGET.toLocaleString(),
      },
    });

    return { content: [{ type: 'text', text: md }] };
  },
};

// ── RAG Pipeline ──

async function executeRAGPipeline(
  question: string,
  env: ResolvedEnv,
  client: OpenRouterClient,
  maxTokens: number,
): Promise<QuestionResult> {
  // Step 1: Generate diverse search queries from the question
  const searchQueries = await generateSearchQueries(env, client, question);

  // Step 2: Search via Serper
  let sources: RAGSource[] = [];
  try {
    const serperClient = new SerperClient(env.SERPER_API_KEY!);
    const searchResponse = await serperClient.searchMultiple(searchQueries, RAG_RESULTS_PER_QUERY);
    const aggregation = aggregateAndRank(searchResponse.searches, 3);
    const topUrls = aggregation.rankedUrls.slice(0, RAG_TOP_URLS).map(u => u.url);

    if (topUrls.length === 0) {
      // No search results — fall back to LLM web search
      return executeFallbackPipeline(question, env, client, maxTokens);
    }

    // Step 3: Scrape top URLs
    const scraperClient = new ScraperClient(env.SCRAPEDO_API_KEY!);
    const scraped = await scraperClient.scrapeMultiple(topUrls, { timeout: RAG_SCRAPE_TIMEOUT });
    const successfulScrapes = scraped.filter(s => !s.error && s.statusCode >= 200 && s.statusCode < 300 && s.content);

    if (successfulScrapes.length === 0) {
      return executeFallbackPipeline(question, env, client, maxTokens);
    }

    // Step 4: Extract key content from each scraped page
    const extractionInstruction = `Extract the most relevant facts, data points, comparisons, and actionable insights related to: "${question}". Focus on specific claims with evidence. Ignore navigation, ads, boilerplate.`;

    const extracted = await pMap(successfulScrapes, async (result) => {
      try {
        let md = htmlToMarkdown(result.content);
        if (md.length > RAG_MAX_CONTENT_PER_SOURCE * 2) {
          md = md.substring(0, RAG_MAX_CONTENT_PER_SOURCE * 2);
        }
        const extractionResult = await extractContent(env, md, extractionInstruction, 4096);
        const content = extractionResult.processed
          ? extractionResult.content
          : md.substring(0, RAG_MAX_CONTENT_PER_SOURCE);
        return { url: result.url, content };
      } catch {
        return null;
      }
    }, RAG_EXTRACT_CONCURRENCY);

    sources = extracted.filter((s): s is RAGSource => s !== null && s.content.length > 50);
  } catch (error) {
    // Search/scrape failed — fall back
    console.warn(`RAG pipeline search/scrape failed: ${classifyError(error).message}. Falling back.`);
    return executeFallbackPipeline(question, env, client, maxTokens);
  }

  if (sources.length === 0) {
    return executeFallbackPipeline(question, env, client, maxTokens);
  }

  // Step 5: Build context from sources (respect token limits)
  let context = '';
  const usedSources: Citation[] = [];
  for (const source of sources) {
    const section = `### Source: ${source.url}\n${source.content}\n\n`;
    if (context.length + section.length > RAG_MAX_CONTEXT_CHARS) break;
    context += section;
    usedSources.push({ url: source.url, title: '' });
  }

  // Step 6: Synthesize — LLM call WITHOUT web search, grounded in sources
  const synthesisQuestion = `**Research Question:** ${question}\n\n**Verified Source Material (${usedSources.length} sources):**\n\n${context}\n\n${RESEARCH_SUFFIX}\n\nCite sources by URL. Synthesize across all sources. If sources conflict, note it.`;

  const reasoningEffort = (env.DEFAULT_REASONING_EFFORT as 'low' | 'medium' | 'high') || 'high';

  const response = await client.research({
    question: synthesisQuestion,
    systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
    reasoningEffort,
    maxTokens,
    disableSearch: true,
  });

  if (response.error && !response.content) {
    return { question, content: '', success: false, error: response.error.message, pipeline: 'rag' };
  }

  // Merge citations from LLM annotations with our source list
  const allCitations = [...usedSources];
  if (response.annotations) {
    for (const a of response.annotations) {
      if (a.url && !allCitations.some(c => c.url === a.url)) {
        allCitations.push({ url: a.url, title: a.title || '' });
      }
    }
  }

  return {
    question,
    content: response.content || '',
    success: !!response.content,
    tokensUsed: response.usage?.totalTokens,
    citations: allCitations.length > 0 ? allCitations : undefined,
    pipeline: 'rag',
  };
}

// ── Fallback pipeline (original LLM web search approach) ──

async function executeFallbackPipeline(
  question: string,
  env: ResolvedEnv,
  client: OpenRouterClient,
  maxTokens: number,
): Promise<QuestionResult> {
  const enhancedQuestion = question + `\n\n${RESEARCH_SUFFIX}`;
  const reasoningEffort = (env.DEFAULT_REASONING_EFFORT as 'low' | 'medium' | 'high') || 'high';
  const maxUrls = env.DEFAULT_MAX_URLS ? parseInt(env.DEFAULT_MAX_URLS, 10) : 100;

  const response = await client.research({
    question: enhancedQuestion,
    systemPrompt: SYSTEM_PROMPT,
    reasoningEffort,
    maxSearchResults: Math.min(maxUrls, 20),
    maxTokens,
  });

  if (response.error) {
    return { question, content: response.content || '', success: false, error: response.error.message, pipeline: 'fallback' };
  }

  const citations: Citation[] = [];
  if (response.annotations && response.annotations.length > 0) {
    const seen = new Set<string>();
    for (const a of response.annotations) {
      if (a.url && !seen.has(a.url)) {
        seen.add(a.url);
        citations.push({ url: a.url, title: a.title || '' });
      }
    }
  }

  return {
    question,
    content: response.content || '',
    success: !!response.content,
    tokensUsed: response.usage?.totalTokens,
    citations: citations.length > 0 ? citations : undefined,
    error: response.content ? undefined : 'Empty response received',
    pipeline: 'fallback',
  };
}

// ── Query generation ──

async function generateSearchQueries(
  env: ResolvedEnv,
  client: OpenRouterClient,
  question: string,
): Promise<string[]> {
  try {
    const prompt = QUERY_GEN_PROMPT
      .replace('{count}', String(RAG_SEARCH_QUERIES))
      .replace('{question}', question);

    const result = await client.extract(prompt, undefined, 512);

    if (result.processed && result.content) {
      const queries = result.content
        .split('\n')
        .map(q => q.trim())
        .filter(q => q.length >= 5 && q.length <= 200)
        .slice(0, RAG_SEARCH_QUERIES);

      if (queries.length >= 3) return queries;
    }
  } catch {
    // Fall through to rule-based generation
  }

  // Rule-based fallback: use the question itself + variations
  return ruleBasedQueries(question);
}

function ruleBasedQueries(question: string): string[] {
  const base = question.replace(/[?!.]+$/, '').trim();
  const short = base.length > 80 ? base.substring(0, 80) : base;
  return [
    base,
    `${short} best practices guide`,
    `${short} comparison 2025 2026`,
  ];
}
