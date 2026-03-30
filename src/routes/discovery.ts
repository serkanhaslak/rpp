import { Hono } from 'hono';
import type { Env } from '../env.js';

export const discoveryRoutes = new Hono<{ Bindings: Env }>();

// RFC 9728: OAuth Protected Resource Metadata
discoveryRoutes.get('/.well-known/oauth-protected-resource', (c) => {
  const baseUrl = getBaseUrl(c);
  return c.json({
    resource: baseUrl,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ['header'],
  });
});

// RFC 8414: OAuth Authorization Server Metadata
discoveryRoutes.get('/.well-known/oauth-authorization-server', (c) => {
  const baseUrl = getBaseUrl(c);
  return c.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['mcp:tools'],
  });
});

function getBaseUrl(c: { req: { url: string } }): string {
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
}
