export interface SessionInfo {
  createdAt: string;
  lastActivity: string;
  protocolVersion: string;
}

export async function createSession(
  kv: KVNamespace,
  sessionId: string,
  opts: { protocolVersion: string; ttlSeconds?: number }
): Promise<void> {
  const now = new Date().toISOString();
  await kv.put(
    `session:${sessionId}`,
    JSON.stringify({
      createdAt: now,
      lastActivity: now,
      protocolVersion: opts.protocolVersion,
    } satisfies SessionInfo),
    { expirationTtl: opts.ttlSeconds || 2592000 }
  );
}

export async function getSession(
  kv: KVNamespace,
  sessionId: string
): Promise<SessionInfo | null> {
  return kv.get(`session:${sessionId}`, 'json');
}

/**
 * Refresh session TTL and update lastActivity timestamp.
 * Reads current session, updates lastActivity, re-puts with refreshed TTL.
 */
export async function touchSession(
  kv: KVNamespace,
  sessionId: string,
  ttlSeconds: number = 2592000
): Promise<void> {
  const session = await getSession(kv, sessionId);
  if (session) {
    session.lastActivity = new Date().toISOString();
    await kv.put(`session:${sessionId}`, JSON.stringify(session), {
      expirationTtl: ttlSeconds,
    });
  }
}

export async function deleteSession(
  kv: KVNamespace,
  sessionId: string
): Promise<void> {
  await kv.delete(`session:${sessionId}`);
}
