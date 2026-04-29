/**
 * Handler for the ACP `session/new` method.
 *
 * Creates a new session and returns its unique identifier.
 *
 * See: https://agentclientprotocol.com/protocol/session-setup#creating-a-session
 */

import type { SessionStore } from "../session-store.ts";

/** Params validated by Zod schema in AcpServer. */
export interface SessionNewParams {
  readonly cwd: string;
  readonly mcpServers?: unknown[];
}

/** Result shape for the session/new handler (matches NewSessionResponse). */
export interface SessionNewResult {
  readonly sessionId: string;
}

/**
 * Handle a `session/new` request.
 *
 * Creates a new session in the store and returns its ID.
 *
 * @param params - The validated request params (cwd, mcpServers).
 * @param sessions - The session store to create the session in.
 * @returns The new session ID.
 */
export function handleSessionNew(
  params: SessionNewParams,
  sessions: SessionStore,
): SessionNewResult {
  // TODO: Connect to MCP servers (post-spike, Tarea 12)
  const session = sessions.create(params.cwd);
  return { sessionId: session.id };
}
