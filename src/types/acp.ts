/**
 * ACP (Agent Client Protocol) types.
 *
 * Re-exports and aliases from the official SDK
 * `@zed-industries/agent-client-protocol@0.4.5`.
 *
 * Where the SDK type name differs from our domain naming,
 * we provide a type alias so callers can use either name.
 */

// ⚠️ All imports from the SDK MUST remain `import type` to prevent
// the entire SDK from being bundled. verbatimModuleSyntax enforces this.
import type {
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  PromptRequest,
  SessionNotification,
  RequestPermissionRequest,
  ContentBlock,
  CancelNotification,
  ClientCapabilities,
  AgentCapabilities,
  AuthMethod,
  ToolCallUpdate,
  PermissionOption,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionResponse,
  ToolKind,
  ToolCallStatus,
  ToolCallLocation,
  ToolCallContent,
  PlanEntry,
  SessionMode,
  SessionModeState,
  Role,
} from "@zed-industries/agent-client-protocol";

export type {
  // Re-export SDK types directly
  InitializeRequest,
  ContentBlock,
  CancelNotification,
  ClientCapabilities,
  AgentCapabilities,
  AuthMethod,
  ToolCallUpdate,
  PermissionOption,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionResponse,
  ToolKind,
  ToolCallStatus,
  ToolCallLocation,
  ToolCallContent,
  PlanEntry,
  SessionMode,
  SessionModeState,
  Role,
};

// Aliases matching our domain naming
export type InitializeResult = InitializeResponse;
export type SessionNewRequest = NewSessionRequest;
export type SessionPromptRequest = PromptRequest;
export type SessionUpdateNotification = SessionNotification;
