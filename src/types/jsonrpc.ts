/**
 * JSON-RPC 2.0 base types for the ACP transport layer.
 *
 * These types define the wire format used for all communication
 * between the agent and the client over stdio NDJSON.
 */

export interface JSONRPCRequest {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

export interface JSONRPCResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: JSONRPCError;
}

export interface JSONRPCError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JSONRPCNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}
