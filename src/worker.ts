import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { Env, ResolvedEnv } from './env.js';
import { resolveEnv } from './env.js';

import { healthRoutes } from './routes/health.js';
import { mcpRoutes } from './routes/mcp.js';
import { oauthRoutes } from './routes/oauth.js';
import { discoveryRoutes } from './routes/discovery.js';

const app = new Hono<{ Bindings: Env; Variables: { resolved: ResolvedEnv } }>();

// Middleware
app.use('*', logger());
app.use('*', cors());

// Resolve Secrets Store bindings to plain strings (once per request)
app.use('*', async (c, next) => {
  const resolved = await resolveEnv(c.env);
  c.set('resolved', resolved);
  return next();
});

// Routes
app.route('/', discoveryRoutes);
app.route('/oauth', oauthRoutes);
app.route('/mcp', mcpRoutes);
app.route('/', healthRoutes);

// Root
app.get('/', (c) =>
  c.json({
    name: c.env.SERVER_NAME,
    version: c.env.SERVER_VERSION,
    protocol: c.env.MCP_PROTOCOL_VERSION,
    transport: 'streamable-http',
  })
);

// 404
app.notFound((c) => c.json({ error: 'Not found', path: c.req.path }, 404));

// Global error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err.message, err.stack);
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;
