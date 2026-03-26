# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

MCP server providing research tools to AI assistants: web search (Google via Serper), Reddit search (also via Serper with `site:reddit.com`) & post extraction (via Reddit OAuth), X/Twitter search (Grok via OpenRouter), URL scraping with optional AI extraction, and AI-powered deep research synthesis. Supports STDIO, HTTP Streamable, and Cloudflare Workers transports. Node.js >= 20.0.0.

## Build & Run

```bash
pnpm build           # tsc + copy src/config/yaml/ to dist/config/
pnpm dev             # tsx live TypeScript
pnpm start               # node dist/index.js
pnpm typecheck       # type check without emitting (does NOT check worker.ts)
```

```bash
pnpm test:web-search     # test web search tool
pnpm test:reddit-search  # test Reddit search
pnpm test:scrape-links   # test scraping
pnpm test:deep-research  # test deep research
pnpm test:all            # run all tests
pnpm test:check          # check environment setup
```

Transport modes:
```bash
npx mcp-research-powerpack                      # STDIO (default)
MCP_TRANSPORT=http MCP_PORT=3000 npx mcp-research-powerpack  # HTTP
```

Binary names: `mcp-research-powerpack`, `research-powerpack-mcp`.

## Environment Variables

Server starts with any configuration — tools are silently disabled if their API keys are missing.

**API keys (each enables a capability):**
| Variable | Enables | Free Tier |
|----------|---------|-----------|
| `SERPER_API_KEY` | `web_search`, `search_reddit` | 2,500 queries/mo |
| `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` | `get_reddit_post` | unlimited |
| `SCRAPEDO_API_KEY` | `scrape_links` | 1,000 credits/mo |
| `OPENROUTER_API_KEY` | `deep_research`, `search_x`, `use_llm` in scrape_links | pay-as-you-go |
| `CEREBRAS_API_KEY` | Cerebras for `scrape_links` extraction | — |
| `USE_CEREBRAS` | Enable Cerebras extraction (`true`/`false`) | `false` |

Note: `search_reddit` uses Google Serper (`site:reddit.com`), NOT the Reddit API. Only `get_reddit_post` uses Reddit OAuth credentials.
Note: `search_x` uses Grok on OpenRouter (not the X/Twitter API directly). It leverages OpenRouter's web plugin which enables native X search for xAI models.

**Optional tuning:**
- `RESEARCH_MODEL` — Primary deep research model (default: `x-ai/grok-4-fast`)
- `RESEARCH_FALLBACK_MODEL` — Fallback when primary fails (default: `google/gemini-2.5-flash`)
- `LLM_EXTRACTION_MODEL` — Extraction model (default: `openai/gpt-oss-120b:nitro`)
- `SESSION_TTL_MS` — HTTP session idle timeout before reaping (default: 1,800,000 / 30min, minimum: 60,000 / 1min)
- `MAX_SESSIONS` — Maximum concurrent HTTP sessions; oldest evicted when exceeded (default: 100, minimum: 1)
- `API_TIMEOUT_MS` — Request timeout (default: 1,800,000 / 30min)
- `DEFAULT_REASONING_EFFORT` — `low|medium|high` (default: `high`)
- `DEFAULT_MAX_URLS` — Max search results per research question (default: 100, range: 10-200)
- `LLM_ENABLE_REASONING` — Enable reasoning in LLM extraction (default: `true`, set `false` to disable)
- `OPENROUTER_BASE_URL` — Override OpenRouter endpoint
- `DEBUG_REDDIT` — Set `true` for Reddit token cache debug logging
- `USE_CEREBRAS` — Set to `true` to use Cerebras (zai-glm-4.7) for content extraction instead of OpenRouter. Requires `CEREBRAS_API_KEY`.
- `CEREBRAS_API_KEY` — API key for Cerebras cloud. Get one at https://cloud.cerebras.ai
- `USAGE_TRACKING` — Set `false` to disable usage tracking (default: `true`)
- `USAGE_DATA_DIR` — Directory for JSONL usage logs (default: `/data/usage`)
- `USAGE_FLUSH_INTERVAL_MS` — Buffer flush interval in ms (default: `5000`)
- `USAGE_MAX_BUFFER_ENTRIES` — Max in-memory buffer entries (default: `10000`)

## Architecture

```
src/
├── index.ts                    # STDIO + HTTP server entry point, graceful shutdown, stdin disconnect detection
├── worker.ts                   # Cloudflare Workers entry point (excluded from tsconfig.json, compiled by Wrangler)
├── version.ts                  # Version string (hardcoded fallback 3.6.9 for Workers where package.json unavailable)
├── config/
│   ├── index.ts                # Env parsing, capability detection, lazy Proxy config objects with resetEnvCache()
│   ├── loader.ts               # YAML tool config loader (readFileSync — incompatible with Workers runtime)
│   ├── types.ts                # Config type definitions
│   └── yaml/tools.yaml         # Complete tool specifications (single source of truth for tool metadata)
├── clients/                    # External API integrations
│   ├── xsearch.ts              # X/Twitter search via Grok on OpenRouter (5 concurrent, :online plugin)
│   ├── search.ts               # Google Serper API (8 concurrent calls)
│   ├── reddit.ts               # Reddit OAuth API (5 concurrent calls, module-level token cache with 60s expiry)
│   ├── scraper.ts              # Scrape.do with 3-mode fallback: basic → JS rendering → JS + US geo
│   └── research.ts             # OpenRouter LLM client (tries primary model, falls back to RESEARCH_FALLBACK_MODEL; Cerebras supported via USE_CEREBRAS)
├── tools/
│   ├── definitions.ts          # Tool metadata generated from YAML
│   ├── registry.ts             # Central handler registry & execution pipeline
│   ├── search.ts               # web_search handler (3-100 parallel keywords)
│   ├── xsearch.ts              # search_x handler (1-20 queries, 5 concurrent, Grok via OpenRouter)
│   ├── reddit.ts               # search_reddit (10-50 queries via Serper) + get_reddit_post (via Reddit API)
│   ├── scrape.ts               # scrape_links handler (1-50 URLs, 10 concurrent, batches of 30)
│   ├── research.ts             # deep_research handler (1-10 questions, 32K token budget, file attachments)
│   └── utils.ts                # Tool-specific utilities
├── schemas/                    # Zod input validation
│   ├── web-search.ts
│   ├── scrape-links.ts
│   └── deep-research.ts
├── services/
│   ├── usage-tracker.ts        # JSONL usage logging — buffered writes, daily file rotation, cost estimation
│   ├── llm-processor.ts        # OpenRouter API integration (3 concurrent extractions, maxRetries: 0)
│   ├── markdown-cleaner.ts     # HTML → Markdown (turndown), truncates at 512K chars, linear-time comment removal
│   └── file-attachment.ts      # File attachment handling for deep_research (reads filesystem, supports line ranges)
└── utils/
    ├── errors.ts               # Error classification: retryable (429, 5xx → backoff) vs non-retryable
    ├── logger.ts               # MCP SDK structured logging (falls back to stderr)
    ├── concurrency.ts          # Bounded parallel execution (pMap)
    ├── url-aggregator.ts       # CTR-weighted URL ranking with consensus detection
    ├── markdown-formatter.ts   # Markdown output formatting
    └── response.ts             # 70/20/10 response formatter (formatSuccess, formatError, formatBatchHeader)
```

**Key design decisions:**
- **Tool specs in YAML** (`config/yaml/tools.yaml`) — single source of truth for tool names, descriptions, and parameter specs. Copied into `dist/config/` during build. If you add new YAML files, they must be in this directory.
- **Never-throw pattern** — server never crashes on tool failures. All errors go through `classifyError()` which categorizes as retryable (429, 5xx → exponential backoff) or non-retryable (→ user-friendly message with setup instructions).
- **Capability-based degradation** — missing API keys disable specific tools with helpful setup instructions rather than failing.
- **Bounded concurrency** — web_search: 8, search_reddit: 8, get_reddit_post: 5 (batches of 10), scrape_links: 10 (batches of 30) + 3 LLM extractions, deep_research: 3, search_x: 5.
- **X search via OpenRouter** — `search_x` uses Grok 4.1 Fast on OpenRouter with the `:online` web plugin, which enables both `web_search` and `x_search` natively for xAI models. Supports handle filtering, date ranges via `x_search_filter`. Cost: ~$0.005/tool call + tokens (~$0.01-0.03 per query total).
- **CTR-weighted URL ranking** — search results ranked by click-through rates with consensus detection across multiple queries.
- **Smart Reddit comment allocation** — 1000 total budget, capped at 200/post: 5+ posts → budget/count each, 2 posts → 200 each (capped from 500).
- **70/20/10 response format** — all tools return: 70% summary, 20% structured data, 10% actionable next steps.
- **Model fallback** — `ResearchClient` tries primary model, then falls back to `RESEARCH_FALLBACK_MODEL` on failure.
- **Scraper fallback** — `ScraperClient.scrapeWithFallback()` tries 3 modes: basic → JavaScript rendering → JavaScript + US geo-targeting.
- **Gemini special handling** — models matching `google/gemini*` get `tools: [{type: 'google_search'}]` instead of `search_parameters`.
- **HTTP session management** — LRU eviction when `MAX_SESSIONS` reached, 1-min reap interval for idle sessions beyond TTL. Evicts rather than rejects (503) for better UX.
- **Usage tracking** — JSONL daily files at `/data/usage/`. Buffered in-memory (5s flush interval), fire-and-forget writes. Tracks tool name, duration, tokens, estimated cost. Graceful degradation to in-memory only when disk unavailable.

**Execution pipeline** (`tools/registry.ts`): lookup tool → check capability → validate with Zod → execute handler → transform response. Every step catches errors gracefully.

## Gotchas

- **ESM project** (`"type": "module"`) — all imports must use `.js` extensions.
- **worker.ts excluded from tsconfig** — `pnpm typecheck` does NOT check the Workers entry point. Use `npx wrangler deploy --dry-run` to verify.
- **Build copies YAML** — the build script copies `src/config/yaml/` to `dist/config/`. New YAML files must be in this directory.
- **version.ts hardcoded fallback** — has a stale fallback version for Workers runtime where `package.json` is unavailable. Can drift from actual version.
- **All OpenAI client instances set `maxRetries: 0`** — retry logic is handled manually with custom backoff.
- **Lazy Proxy config** — `RESEARCH`, `LLM_EXTRACTION` config objects use Proxy for deferred env reads. `resetEnvCache()` clears them for Workers env bridging.
- **stdin disconnect detection** — explicit handlers for `stdin close/end` and `stdout EPIPE` to prevent 100% CPU when parent process disconnects.

## Cloudflare Workers

`src/worker.ts` bridges Cloudflare env bindings into `process.env` so config modules work in both STDIO and Workers. Avoids importing `tools/definitions.ts` (which uses filesystem YAML loading) and instead registers tools directly from the registry. Uses Durable Objects (`ResearchMcpPowerpack` class with SQLite). Custom domain: `mcp-research-powerpack.workers.yigitkonur.com`.

## CI/CD

GitHub Actions (`.github/workflows/npm-publish.yml`): pushes to main auto-publish to npm. Auto-bumps patch version if already published. Ignores markdown/docs-only changes. `[skip ci]` in commit message skips build. Manual trigger supports patch/minor/major bump.
