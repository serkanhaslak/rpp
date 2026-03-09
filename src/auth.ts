// src/auth.ts — Minimal OAuth 2.0 for Claude custom connectors
// Enabled when OAUTH_CLIENT_ID + OAUTH_CLIENT_SECRET are set.
// Implements: RFC 9728 resource metadata, authorization server metadata,
// authorization code flow with PKCE (S256), token endpoint.

import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CLIENT_ID = () => process.env.OAUTH_CLIENT_ID || '';
const CLIENT_SECRET = () => process.env.OAUTH_CLIENT_SECRET || '';
const TOKEN_STORE_PATH = process.env.TOKEN_STORE_PATH || '/data/tokens.json';

export const isAuthEnabled = (): boolean => !!(CLIENT_ID() && CLIENT_SECRET());

// ---------------------------------------------------------------------------
// Persistent token store — survives restarts via volume mount
// ---------------------------------------------------------------------------

interface StoredCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
}

interface TokenEntry {
  token: string;
  createdAt: number;
  expiresAt: number;
}

interface TokenStoreData {
  tokens: TokenEntry[];
}

const TOKEN_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days

function loadTokens(): Set<string> {
  try {
    if (!existsSync(TOKEN_STORE_PATH)) return new Set();
    const data: TokenStoreData = JSON.parse(readFileSync(TOKEN_STORE_PATH, 'utf-8'));
    const now = Date.now();
    const valid = data.tokens.filter(t => t.expiresAt > now);
    return new Set(valid.map(t => t.token));
  } catch {
    return new Set();
  }
}

function saveTokens(tokens: Set<string>, entries: Map<string, TokenEntry>): void {
  try {
    const dir = TOKEN_STORE_PATH.substring(0, TOKEN_STORE_PATH.lastIndexOf('/'));
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data: TokenStoreData = { tokens: [...entries.values()] };
    writeFileSync(TOKEN_STORE_PATH, JSON.stringify(data), 'utf-8');
  } catch {
    // Silent fail — falls back to in-memory only
  }
}

const tokenEntries = new Map<string, TokenEntry>();
const accessTokens: Set<string> = loadTokens();
// Rebuild entries map from loaded tokens (without original timestamps, set conservative expiry)
for (const t of accessTokens) {
  tokenEntries.set(t, { token: t, createdAt: Date.now(), expiresAt: Date.now() + TOKEN_TTL_MS });
}

const authCodes = new Map<string, StoredCode>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getBaseUrl(req: IncomingMessage): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => resolve(body));
  });
}

function verifyPkce(verifier: string, challenge: string): boolean {
  return createHash('sha256').update(verifier).digest('base64url') === challenge;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Auth middleware — call before handling /mcp requests
// ---------------------------------------------------------------------------

export function validateRequest(req: IncomingMessage): boolean {
  if (!isAuthEnabled()) return true;
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  if (!accessTokens.has(token)) return false;
  const entry = tokenEntries.get(token);
  if (entry && entry.expiresAt < Date.now()) {
    accessTokens.delete(token);
    tokenEntries.delete(token);
    saveTokens(accessTokens, tokenEntries);
    return false;
  }
  return true;
}

export function sendUnauthorized(req: IncomingMessage, res: ServerResponse): void {
  const base = getBaseUrl(req);
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
  });
  res.end(JSON.stringify({ error: 'unauthorized' }));
}

// ---------------------------------------------------------------------------
// OAuth route handler — returns true if it handled the request
// ---------------------------------------------------------------------------

export async function handleOAuth(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const base = getBaseUrl(req);

  // ---- Protected Resource Metadata (RFC 9728) ----
  if (url.pathname === '/.well-known/oauth-protected-resource') {
    if (!isAuthEnabled()) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Auth not configured' }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      resource: base,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
    }));
    return true;
  }

  // ---- Authorization Server Metadata ----
  if (url.pathname === '/.well-known/oauth-authorization-server') {
    if (!isAuthEnabled()) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Auth not configured' }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
    }));
    return true;
  }

  // ---- Authorization Endpoint ----
  if (url.pathname === '/oauth/authorize' && isAuthEnabled()) {
    if (req.method === 'GET') {
      const clientId = url.searchParams.get('client_id') || '';
      const redirectUri = url.searchParams.get('redirect_uri') || '';
      const state = url.searchParams.get('state') || '';
      const codeChallenge = url.searchParams.get('code_challenge') || '';
      const codeChallengeMethod = url.searchParams.get('code_challenge_method') || '';
      const responseType = url.searchParams.get('response_type');

      if (responseType !== 'code' || clientId !== CLIENT_ID()) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>Invalid request</h1>');
        return true;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Research Powerpack</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#0f0f0f;color:#e0e0e0;
display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{background:#1a1a1a;border:1px solid #333;border-radius:16px;padding:40px;max-width:420px;width:100%;text-align:center}
h2{font-size:20px;margin-bottom:8px;color:#fff}
.sub{color:#888;font-size:14px;margin-bottom:24px}
.tools{text-align:left;background:#111;border-radius:8px;padding:16px;margin-bottom:24px}
.tools li{color:#aaa;font-size:13px;padding:4px 0;list-style:none}
.tools li::before{content:"\\2192 ";color:#6f42c1}
button{background:#6f42c1;color:#fff;border:none;padding:12px 32px;border-radius:8px;
font-size:15px;cursor:pointer;width:100%;transition:opacity .2s}
button:hover{opacity:.85}
.note{color:#666;font-size:11px;margin-top:16px}
</style></head>
<body><div class="card">
<h2>Research Powerpack MCP</h2>
<p class="sub">Claude is requesting access to your research tools</p>
<ul class="tools">
<li>Google Search</li>
<li>Reddit Search &amp; Fetch</li>
<li>Web Scraping with AI Extraction</li>
<li>Deep Research Synthesis</li>
</ul>
<form method="POST" action="/oauth/authorize">
<input type="hidden" name="client_id" value="${esc(clientId)}">
<input type="hidden" name="redirect_uri" value="${esc(redirectUri)}">
<input type="hidden" name="state" value="${esc(state)}">
<input type="hidden" name="code_challenge" value="${esc(codeChallenge)}">
<input type="hidden" name="code_challenge_method" value="${esc(codeChallengeMethod)}">
<button type="submit">Approve Access</button>
</form>
<p class="note">Grants Claude access to your self-hosted research tools.</p>
</div></body></html>`);
      return true;
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const p = new URLSearchParams(body);
      const clientId = p.get('client_id') || '';
      const redirectUri = p.get('redirect_uri') || '';
      const state = p.get('state') || '';
      const codeChallenge = p.get('code_challenge') || '';

      if (clientId !== CLIENT_ID()) {
        res.writeHead(400).end('Invalid client');
        return true;
      }

      const code = randomUUID();
      authCodes.set(code, {
        clientId,
        redirectUri,
        codeChallenge,
        expiresAt: Date.now() + 5 * 60_000, // 5 min
      });

      const target = new URL(redirectUri);
      target.searchParams.set('code', code);
      if (state) target.searchParams.set('state', state);
      res.writeHead(302, { Location: target.toString() });
      res.end();
      return true;
    }
  }

  // ---- Token Endpoint ----
  if (url.pathname === '/oauth/token' && req.method === 'POST' && isAuthEnabled()) {
    const body = await readBody(req);
    const p = new URLSearchParams(body);

    const grantType = p.get('grant_type');
    const code = p.get('code') || '';
    const clientId = p.get('client_id') || '';
    const clientSecret = p.get('client_secret') || '';
    const codeVerifier = p.get('code_verifier') || '';
    const redirectUri = p.get('redirect_uri') || '';

    if (grantType !== 'authorization_code') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
      return true;
    }

    if (clientId !== CLIENT_ID() || clientSecret !== CLIENT_SECRET()) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_client' }));
      return true;
    }

    const stored = authCodes.get(code);
    if (!stored || stored.expiresAt < Date.now() || stored.redirectUri !== redirectUri) {
      authCodes.delete(code);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant' }));
      return true;
    }

    if (stored.codeChallenge && !verifyPkce(codeVerifier, stored.codeChallenge)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE verification failed' }));
      return true;
    }

    // Consume code (one-time use)
    authCodes.delete(code);

    // Issue access token — persisted to volume
    const token = randomUUID();
    const entry: TokenEntry = { token, createdAt: Date.now(), expiresAt: Date.now() + TOKEN_TTL_MS };
    accessTokens.add(token);
    tokenEntries.set(token, entry);
    saveTokens(accessTokens, tokenEntries);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      access_token: token,
      token_type: 'bearer',
      expires_in: Math.floor(TOKEN_TTL_MS / 1000), // 30 days
    }));
    return true;
  }

  return false; // Not an OAuth route
}
