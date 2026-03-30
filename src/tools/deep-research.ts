/**
 * Deep Research Tool — AI-powered research synthesis with web search
 * NEVER throws — catches all errors and returns ToolResult with isError: true
 */

import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import type { ResolvedEnv } from '../env.js';
import { OpenRouterClient, type ResearchResponse } from '../clients/openrouter.js';
import { pMap } from '../lib/concurrency.js';
import { formatSuccess, formatError, formatBatchHeader, formatDuration, truncateText, TOKEN_BUDGET } from '../lib/response.js';
import { classifyError } from '../lib/errors.js';

// ── Constants ──

const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 10;

const SYSTEM_PROMPT = `Expert research engine. Multi-source: docs, papers, blogs, case studies. Cite inline [source].

FORMAT RULES:
- For comparisons/features/structured data -> use markdown table |Col|Col|Col|
- For narrative/diagnostic/explanation -> tight numbered bullets, no prose paragraphs
- No intro, no greeting, no conclusion, no meta-commentary
- No filler phrases: "it is worth noting", "overall", "in conclusion", "importantly"
- Every sentence = fact, data point, or actionable insight
- First line of output = content (never a preamble)`;

const RESEARCH_SUFFIX = `IMPORTANT: Be information-dense. No filler. Every sentence must contain a fact, data point, or actionable insight.
If comparing options, use a markdown table. Cite sources inline [source].
Start immediately with content — no preamble or meta-commentary.`;

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

    // Validate question count
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

    // Initialize research client
    let client: OpenRouterClient;
    try {
      client = new OpenRouterClient(env.OPENROUTER_API_KEY!, {
        model: env.RESEARCH_MODEL,
        fallbackModel: env.RESEARCH_FALLBACK_MODEL,
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
          alternatives: [
            'web_search(keywords=["topic best practices", "topic guide"]) — uses Serper API (different key)',
            'search_reddit(queries=["topic recommendations"]) — uses Serper API, get community perspective',
          ],
        }) }],
        isError: true,
      };
    }

    // Execute research questions
    const results = await pMap(questions, async (q, index): Promise<QuestionResult> => {
      try {
        // Warn about file attachments in Workers environment
        let enhancedQuestion = q.question;
        if (q.file_attachments && q.file_attachments.length > 0) {
          enhancedQuestion += '\n\n[Note: File attachments are not supported in the Workers environment and have been ignored.]';
        }
        enhancedQuestion += `\n\n${RESEARCH_SUFFIX}`;

        const reasoningEffort = (env.DEFAULT_REASONING_EFFORT as 'low' | 'medium' | 'high') || 'high';
        const maxUrls = env.DEFAULT_MAX_URLS ? parseInt(env.DEFAULT_MAX_URLS, 10) : 100;

        const response = await client.research({
          question: enhancedQuestion,
          systemPrompt: SYSTEM_PROMPT,
          reasoningEffort,
          maxSearchResults: Math.min(maxUrls, 20),
          maxTokens: tokensPerQuestion,
        });

        if (response.error) {
          return { question: q.question, content: response.content || '', success: false, error: response.error.message };
        }

        // Extract unique citations from annotations
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
          question: q.question,
          content: response.content || '',
          success: !!response.content,
          tokensUsed: response.usage?.totalTokens,
          citations: citations.length > 0 ? citations : undefined,
          error: response.content ? undefined : 'Empty response received',
        };
      } catch (error) {
        const structuredError = classifyError(error);
        return { question: q.question, content: '', success: false, error: structuredError.message };
      }
    }, 3);

    const executionTime = Date.now() - startTime;

    // Build output
    const successfulResults = results.filter(r => r.success);
    const failedResults = results.filter(r => !r.success);
    const totalTokens = successfulResults.reduce((sum, r) => sum + (r.tokensUsed || 0), 0);

    const batchHeader = formatBatchHeader({
      title: `Deep Research Results`,
      totalItems: questions.length,
      successful: successfulResults.length,
      failed: failedResults.length,
      tokensPerItem: tokensPerQuestion,
      extras: { 'Total tokens used': totalTokens.toLocaleString() },
    });

    // Build question data sections
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

    // Aggregate citations for scrape suggestion
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
