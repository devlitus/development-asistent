/**
 * Handler for the ACP `initialize` method.
 *
 * Responds with the agent's capabilities and the negotiated
 * protocol version.
 *
 * See: https://agentclientprotocol.com/protocol/initialization
 */

import { PROTOCOL_VERSION } from "@zed-industries/agent-client-protocol";
import type { InitializeResponse } from "@zed-industries/agent-client-protocol";

/** Cached initialize response — always the same for this agent. */
const INITIALIZE_RESPONSE: InitializeResponse = Object.freeze({
  protocolVersion: PROTOCOL_VERSION,
  agentCapabilities: {
    loadSession: false,
  },
});

/**
 * Handle an `initialize` request.
 *
 * Returns the protocol version and agent capabilities.
 * In this spike phase, we only support basic text —
 * no tools, no loadSession, no MCP.
 */
export function handleInitialize(): InitializeResponse {
  return INITIALIZE_RESPONSE;
}
