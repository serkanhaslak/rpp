/**
 * Raw Worker env bindings.
 * Secrets Store secrets are objects with .get() — NOT plain strings.
 * Use resolveEnv() to get a ResolvedEnv with all secrets as strings.
 */
export interface Env {
  // KV Namespaces
  OAUTH_TOKENS: KVNamespace;
  MCP_SESSIONS: KVNamespace;

  // Server config (plain vars — always strings)
  SERVER_NAME: string;
  SERVER_VERSION: string;
  MCP_PROTOCOL_VERSION: string;
  SESSION_TTL_SECONDS: string;
  MAX_SESSIONS: string;

  // API Keys — may be string (wrangler secret) or SecretStoreSecret object
  SERPER_API_KEY?: string | SecretStoreBinding;
  REDDIT_CLIENT_ID?: string | SecretStoreBinding;
  REDDIT_CLIENT_SECRET?: string | SecretStoreBinding;
  SCRAPEDO_API_KEY?: string | SecretStoreBinding;
  OPENROUTER_API_KEY?: string | SecretStoreBinding;
  OPENROUTER_BASE_URL?: string;

  // OAuth credentials
  OAUTH_CLIENT_ID?: string | SecretStoreBinding;
  OAUTH_CLIENT_SECRET?: string | SecretStoreBinding;

  // AI Model config
  RESEARCH_MODEL?: string;
  RESEARCH_FALLBACK_MODEL?: string;
  LLM_EXTRACTION_MODEL?: string;

  // Tuning
  DEFAULT_REASONING_EFFORT?: string;
  DEFAULT_MAX_URLS?: string;
  API_TIMEOUT_MS?: string;
}

/** Secrets Store binding — has async .get() method */
interface SecretStoreBinding {
  get(): Promise<string>;
}

/**
 * Env with all secrets resolved to plain strings.
 * This is what tool handlers and clients receive.
 */
export interface ResolvedEnv {
  OAUTH_TOKENS: KVNamespace;
  MCP_SESSIONS: KVNamespace;

  SERVER_NAME: string;
  SERVER_VERSION: string;
  MCP_PROTOCOL_VERSION: string;
  SESSION_TTL_SECONDS: string;
  MAX_SESSIONS: string;

  SERPER_API_KEY?: string;
  REDDIT_CLIENT_ID?: string;
  REDDIT_CLIENT_SECRET?: string;
  SCRAPEDO_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_BASE_URL?: string;

  OAUTH_CLIENT_ID?: string;
  OAUTH_CLIENT_SECRET?: string;

  RESEARCH_MODEL?: string;
  RESEARCH_FALLBACK_MODEL?: string;
  LLM_EXTRACTION_MODEL?: string;

  DEFAULT_REASONING_EFFORT?: string;
  DEFAULT_MAX_URLS?: string;
  API_TIMEOUT_MS?: string;
}

/** Resolve a value that may be a string, SecretStoreSecret, or undefined */
async function resolveSecret(val: string | SecretStoreBinding | undefined): Promise<string | undefined> {
  if (!val) return undefined;
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && 'get' in val && typeof val.get === 'function') {
    return val.get();
  }
  return String(val);
}

/**
 * Resolve all Secrets Store bindings to plain strings.
 * Call once per request. Safe for both Workers (SecretStoreSecret objects)
 * and STDIO mode (plain strings from process.env).
 */
export async function resolveEnv(raw: Env): Promise<ResolvedEnv> {
  const [
    serperKey, redditId, redditSecret, scrapedoKey,
    openrouterKey, oauthClientId, oauthClientSecret,
  ] = await Promise.all([
    resolveSecret(raw.SERPER_API_KEY),
    resolveSecret(raw.REDDIT_CLIENT_ID),
    resolveSecret(raw.REDDIT_CLIENT_SECRET),
    resolveSecret(raw.SCRAPEDO_API_KEY),
    resolveSecret(raw.OPENROUTER_API_KEY),
    resolveSecret(raw.OAUTH_CLIENT_ID),
    resolveSecret(raw.OAUTH_CLIENT_SECRET),
  ]);

  return {
    OAUTH_TOKENS: raw.OAUTH_TOKENS,
    MCP_SESSIONS: raw.MCP_SESSIONS,
    SERVER_NAME: raw.SERVER_NAME,
    SERVER_VERSION: raw.SERVER_VERSION,
    MCP_PROTOCOL_VERSION: raw.MCP_PROTOCOL_VERSION,
    SESSION_TTL_SECONDS: raw.SESSION_TTL_SECONDS,
    MAX_SESSIONS: raw.MAX_SESSIONS,
    SERPER_API_KEY: serperKey,
    REDDIT_CLIENT_ID: redditId,
    REDDIT_CLIENT_SECRET: redditSecret,
    SCRAPEDO_API_KEY: scrapedoKey,
    OPENROUTER_API_KEY: openrouterKey,
    OPENROUTER_BASE_URL: typeof raw.OPENROUTER_BASE_URL === 'string' ? raw.OPENROUTER_BASE_URL : undefined,
    OAUTH_CLIENT_ID: oauthClientId,
    OAUTH_CLIENT_SECRET: oauthClientSecret,
    RESEARCH_MODEL: raw.RESEARCH_MODEL,
    RESEARCH_FALLBACK_MODEL: raw.RESEARCH_FALLBACK_MODEL,
    LLM_EXTRACTION_MODEL: raw.LLM_EXTRACTION_MODEL,
    DEFAULT_REASONING_EFFORT: raw.DEFAULT_REASONING_EFFORT,
    DEFAULT_MAX_URLS: raw.DEFAULT_MAX_URLS,
    API_TIMEOUT_MS: raw.API_TIMEOUT_MS,
  };
}

export interface Capabilities {
  search: boolean;
  reddit: boolean;
  scraping: boolean;
  deepResearch: boolean;
  xSearch: boolean;
  llmExtraction: boolean;
}

export function getCapabilities(env: ResolvedEnv): Capabilities {
  return {
    search: !!env.SERPER_API_KEY,
    reddit: !!env.REDDIT_CLIENT_ID && !!env.REDDIT_CLIENT_SECRET,
    scraping: !!env.SCRAPEDO_API_KEY,
    deepResearch: !!env.OPENROUTER_API_KEY,
    xSearch: !!env.OPENROUTER_API_KEY,
    llmExtraction: !!env.OPENROUTER_API_KEY,
  };
}
