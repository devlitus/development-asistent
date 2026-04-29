/**
 * Transport layer barrel export.
 *
 * Re-exports all public APIs from the stdio JSON-RPC transport module.
 */

export { StdioTransport } from "./stdio.ts";

export type {
  MessageHandler,
  TransportOutput,
  StdioTransportOptions,
} from "./stdio.ts";
