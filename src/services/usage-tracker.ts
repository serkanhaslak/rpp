/**
 * Usage Tracker — JSONL-based tool usage logging with buffered writes
 * Tracks tool calls, token counts, costs, and execution times.
 * Writes daily JSONL files to a configurable data directory (/data/usage by default).
 * Gracefully degrades to in-memory only when disk is unavailable.
 * NEVER crashes the server.
 */

import { mkdirSync, appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { mcpLog } from '../utils/logger.js';

// ── Config (inline to avoid circular dep with config/index.ts) ──

function getConfig() {
  return {
    ENABLED: process.env.USAGE_TRACKING !== 'false',
    DATA_DIR: process.env.USAGE_DATA_DIR || '/data/usage',
    FLUSH_INTERVAL_MS: Math.max(1000, parseInt(process.env.USAGE_FLUSH_INTERVAL_MS || '5000', 10) || 5000),
    MAX_BUFFER_ENTRIES: Math.max(100, parseInt(process.env.USAGE_MAX_BUFFER_ENTRIES || '10000', 10) || 10000),
  };
}

// ── Types ──

export interface UsageEntry {
  readonly tool: string;
  readonly timestamp: string;
  readonly durationMs: number;
  readonly success: boolean;
  readonly error?: string;
  readonly totalTokens?: number;
  readonly estimatedCostUsd?: number;
}

export interface UsageSummary {
  readonly period: string;
  readonly totalCalls: number;
  readonly totalErrors: number;
  readonly totalTokens: number;
  readonly totalCostUsd: number;
  readonly byTool: Record<string, { calls: number; tokens: number; costUsd: number; errors: number }>;
}

// ── Cost table (USD per token) ──

const TOOL_COST_PER_TOKEN: Record<string, number | null> = {
  // Grok 4.1 Fast via OpenRouter: ~$0.20/M input, ~$1.00/M output
  // Blended estimate assuming ~30% input / 70% output
  search_x: 0.76 / 1_000_000,
  deep_research: 0.76 / 1_000_000,
  // Free tools
  web_search: null,
  search_reddit: null,
  search_news: null,
  search_hackernews: null,
  get_reddit_post: null,
  // scrape_links cost depends on use_llm — tracked as null, tokens still logged
  scrape_links: null,
};

// Per-call fixed costs (OpenRouter web search plugin)
const TOOL_FIXED_COST: Record<string, number> = {
  search_x: 0.005, // $5/1k native xAI search calls
};

// ── Token extraction ──

const TOKEN_REGEX = /tokens?\s*(?:used)?:?\s*~?([\d,]+)/gi;

export function extractTokensFromResult(text: string): number | undefined {
  let total = 0;
  let found = false;
  for (const m of text.matchAll(TOKEN_REGEX)) {
    const val = parseInt(m[1]!.replace(/,/g, ''), 10);
    if (!isNaN(val)) { total += val; found = true; }
  }
  return found ? total : undefined;
}

function estimateCost(tool: string, totalTokens?: number): number | undefined {
  const fixed = TOOL_FIXED_COST[tool] || 0;
  const perToken = TOOL_COST_PER_TOKEN[tool];
  if (perToken != null && totalTokens != null) {
    return fixed + totalTokens * perToken;
  }
  return fixed > 0 ? fixed : undefined;
}

// ── Singleton state ──

let buffer: UsageEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let diskAvailable = false;
let initialized = false;
let diskWarningLogged = false;

function todayFile(): string {
  const d = new Date();
  const date = d.toISOString().slice(0, 10); // YYYY-MM-DD
  return `${getConfig().DATA_DIR}/${date}.jsonl`;
}

// ── Public API ──

export function initUsageTracker(): void {
  const cfg = getConfig();
  if (!cfg.ENABLED) {
    mcpLog('info', 'Usage tracking disabled (USAGE_TRACKING=false)', 'usage');
    return;
  }

  try {
    mkdirSync(cfg.DATA_DIR, { recursive: true });
    diskAvailable = true;
    mcpLog('info', `Usage tracker initialized → ${cfg.DATA_DIR}`, 'usage');
  } catch {
    diskAvailable = false;
    mcpLog('warning', `Usage tracker: disk unavailable (${cfg.DATA_DIR}), in-memory only`, 'usage');
  }

  flushTimer = setInterval(() => flushBuffer(), cfg.FLUSH_INTERVAL_MS);
  flushTimer.unref();
  initialized = true;
}

export function track(entry: UsageEntry): void {
  if (!getConfig().ENABLED) return;
  const cfg = getConfig();
  buffer.push(entry);
  // Cap buffer to prevent memory leak
  if (buffer.length > cfg.MAX_BUFFER_ENTRIES) {
    buffer = buffer.slice(-cfg.MAX_BUFFER_ENTRIES);
  }
}

export function trackToolCall(
  tool: string,
  durationMs: number,
  success: boolean,
  result?: string,
  error?: string,
): void {
  const totalTokens = result ? extractTokensFromResult(result) : undefined;
  const estimatedCostUsd = estimateCost(tool, totalTokens);
  track({
    tool,
    timestamp: new Date().toISOString(),
    durationMs,
    success,
    error,
    totalTokens,
    estimatedCostUsd,
  });
}

export function shutdownUsageTracker(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  flushSync();
}

// ── Flush logic ──

let flushing = false;

function flushBuffer(): void {
  if (flushing || buffer.length === 0 || !diskAvailable) return;
  flushing = true;
  const entries = buffer.splice(0);
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  appendFile(todayFile(), lines, 'utf-8')
    .catch((err) => {
      // Put entries back and warn once
      buffer.unshift(...entries);
      if (!diskWarningLogged) {
        mcpLog('warning', `Usage tracker flush failed: ${err?.message || 'unknown'}`, 'usage');
        diskWarningLogged = true;
      }
    })
    .finally(() => { flushing = false; });
}

function flushSync(): void {
  if (buffer.length === 0) return;
  if (!diskAvailable) return;
  try {
    const lines = buffer.map(e => JSON.stringify(e)).join('\n') + '\n';
    appendFileSync(todayFile(), lines, 'utf-8');
    buffer = [];
  } catch {
    // Best effort — data stays in memory
  }
}

// ── Stats (read JSONL files) ──

export function getUsageStats(days: number = 1): UsageSummary {
  const byTool: Record<string, { calls: number; tokens: number; costUsd: number; errors: number }> = {};
  let totalCalls = 0;
  let totalErrors = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;

  const entries: UsageEntry[] = [...buffer];

  // Read JSONL files for the requested date range
  if (diskAvailable) {
    const cfg = getConfig();
    try {
      const files = readdirSync(cfg.DATA_DIR).filter(f => f.endsWith('.jsonl')).sort().reverse();
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      for (const file of files) {
        const dateStr = file.replace('.jsonl', '');
        if (dateStr < cutoffStr) break;
        try {
          const content = readFileSync(`${cfg.DATA_DIR}/${file}`, 'utf-8');
          for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
          }
        } catch { /* skip unreadable files */ }
      }
    } catch { /* dir unreadable */ }
  }

  for (const e of entries) {
    totalCalls++;
    if (!e.success) totalErrors++;
    totalTokens += e.totalTokens || 0;
    totalCostUsd += e.estimatedCostUsd || 0;

    if (!byTool[e.tool]) {
      byTool[e.tool] = { calls: 0, tokens: 0, costUsd: 0, errors: 0 };
    }
    const t = byTool[e.tool]!;
    t.calls++;
    t.tokens += e.totalTokens || 0;
    t.costUsd += e.estimatedCostUsd || 0;
    if (!e.success) t.errors++;
  }

  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - days);
  const period = days === 1 ? 'today' : `last ${days} days`;

  return { period, totalCalls, totalErrors, totalTokens, totalCostUsd, byTool };
}
