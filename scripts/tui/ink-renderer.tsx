/**
 * ink-renderer.tsx — INK-02
 *
 * Implementación de IRenderer usando Ink/React.
 * La clase InkRenderer actualiza un estado React centralizado (TuiAppState)
 * que el componente <TuiApp> lee y renderiza con Ink.
 *
 * Scope INK-02: esqueleto funcional con puente clase↔React.
 * Los componentes visuales detallados se implementan en INK-04.
 */

import React, { useState, useEffect } from "react";
import { Box } from "ink";
import type { IRenderer } from "./interfaces.ts";
import type { TuiStatus, PermissionRequest } from "./types.ts";
import { Header } from "./components/Header.tsx";
import { ConversationArea } from "./components/ConversationArea.tsx";
import { SpinnerLine } from "./components/SpinnerLine.tsx";
import { InputLine } from "./components/InputLine.tsx";

// ─── DisplayMessage ───────────────────────────────────────────────────────────

export type DisplayMessage =
  | { kind: "user";        text: string }
  | { kind: "agent";       text: string }
  | { kind: "system";      text: string }
  | { kind: "error";       text: string }
  | { kind: "routing";     agentName: string }
  | { kind: "tool_call";   name: string; input: unknown }
  | { kind: "tool_result"; name: string; status: string }
  | { kind: "separator" }
  | { kind: "permission";  req: PermissionRequest };

// ─── TuiAppState ─────────────────────────────────────────────────────────────

export interface TuiAppState {
  version: string;
  status: TuiStatus;
  messages: DisplayMessage[];
  streamBuffer: string;
  isThinking: boolean;
  inputValue: string;
  inputEnabled: boolean;
  onSubmit?: (text: string) => void;
  pendingPermission?: PermissionRequest;
  onPermissionResponse?: (answer: string) => void;
  scrollOffset: number; // 0 = al final, N = N mensajes desde el final
  /** Callbacks de scroll inyectados por InkInput.start() */
  onArrowUp?: () => void;
  onArrowDown?: () => void;
}

export const initialTuiAppState: TuiAppState = {
  version: "",
  status: "connecting",
  messages: [],
  streamBuffer: "",
  isThinking: false,
  inputValue: "",
  inputEnabled: true,
  pendingPermission: undefined,
  onPermissionResponse: undefined,
  scrollOffset: 0,
};

// ─── SetAppState type ─────────────────────────────────────────────────────────

export type SetAppState = React.Dispatch<React.SetStateAction<TuiAppState>>;

// ─── InkRenderer ─────────────────────────────────────────────────────────────

const MAX_MESSAGES = 200;

/**
 * Implementa IRenderer actualizando TuiAppState vía setAppState.
 * Recibe setAppState en el constructor (inyectado desde TuiApp.onReady).
 */
export class InkRenderer implements IRenderer {
  private pendingChunks: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly setAppState: SetAppState) {}

  private withMessage(s: TuiAppState, msg: DisplayMessage): TuiAppState {
    const messages =
      s.messages.length >= MAX_MESSAGES
        ? [...s.messages.slice(-(MAX_MESSAGES - 1)), msg]
        : [...s.messages, msg];
    return { ...s, messages };
  }

  renderHeader(version: string): void {
    this.setAppState((s) => ({ ...s, version }));
  }

  renderStatusBar(status: TuiStatus): void {
    this.setAppState((s) => ({ ...s, status }));
  }

  renderUserMessage(text: string): void {
    this.setAppState((s) =>
      this.withMessage(s, { kind: "user", text } satisfies DisplayMessage),
    );
  }

  renderAgentMessageStart(): void {
    this.setAppState((s) => ({ ...s, streamBuffer: "" }));
  }

  renderStreamChunk(chunk: string): void {
    this.pendingChunks.push(chunk);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        const combined = this.pendingChunks.join("");
        this.pendingChunks = [];
        this.flushTimer = null;
        this.setAppState((s) => ({ ...s, streamBuffer: s.streamBuffer + combined }));
      }, 16);
    }
  }

  renderAgentMessageEnd(): void {
    // Flush pending chunks immediately before closing the message
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      const combined = this.pendingChunks.join("");
      this.pendingChunks = [];
      if (combined) {
        this.setAppState((s) => ({ ...s, streamBuffer: s.streamBuffer + combined }));
      }
    }
    this.setAppState((s) => {
      if (!s.streamBuffer) return s;
      return {
        ...this.withMessage(s, { kind: "agent", text: s.streamBuffer } satisfies DisplayMessage),
        streamBuffer: "",
      };
    });
  }

  renderSystemMessage(text: string): void {
    this.setAppState((s) =>
      this.withMessage(s, { kind: "system", text } satisfies DisplayMessage),
    );
  }

  renderError(message: string): void {
    this.setAppState((s) =>
      this.withMessage(s, { kind: "error", text: message } satisfies DisplayMessage),
    );
  }

  renderPermissionRequest(req: PermissionRequest): void {
    this.setAppState((s) =>
      this.withMessage(s, { kind: "permission", req } satisfies DisplayMessage),
    );
  }

  renderTurnSeparator(): void {
    this.setAppState((s) =>
      this.withMessage(s, { kind: "separator" } satisfies DisplayMessage),
    );
  }

  startSpinner(_label?: string): void {
    this.setAppState((s) => ({ ...s, isThinking: true }));
  }

  stopSpinner(): void {
    this.setAppState((s) => ({ ...s, isThinking: false }));
  }

  renderRoutingInfo(agentName: string): void {
    this.setAppState((s) =>
      this.withMessage(s, { kind: "routing", agentName } satisfies DisplayMessage),
    );
  }

  renderToolCall(name: string, input: unknown): void {
    this.setAppState((s) =>
      this.withMessage(s, { kind: "tool_call", name, input } satisfies DisplayMessage),
    );
  }

  renderToolResult(toolName: string, content: string): void {
    this.setAppState((s) =>
      this.withMessage(s, { kind: "tool_result", name: toolName, status: content } satisfies DisplayMessage),
    );
  }

  clearMessages(): void {
    this.setAppState((s) => ({ ...s, messages: [], streamBuffer: "" }));
  }

  resetScroll(): void {
    this.setAppState((s) => ({ ...s, scrollOffset: 0 }));
  }
}

// ─── TuiApp ───────────────────────────────────────────────────────────────────

export interface TuiAppProps {
  /** Callback invocado una vez con setState para que InkRenderer pueda actualizarlo. */
  onReady: (setState: SetAppState) => void;
}

/**
 * Componente raíz Ink.
 * INK-04: layout completo con Header, ConversationArea, SpinnerLine e InputLine.
 */
export function TuiApp({ onReady }: TuiAppProps): React.ReactElement {
  const [state, setState] = useState<TuiAppState>(initialTuiAppState);

  useEffect(() => {
    onReady(setState);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Box flexDirection="column" height={process.stdout.rows ?? 24}>
      <Header version={state.version} status={state.status} />
      <Box flexGrow={1}>
        <ConversationArea
          messages={state.messages}
          streamBuffer={state.streamBuffer}
          scrollOffset={state.scrollOffset}
        />
      </Box>
      <SpinnerLine active={state.isThinking} />
      <InputLine
        enabled={state.inputEnabled}
        onSubmit={state.onSubmit ?? (() => {})}
        onArrowUp={state.onArrowUp}
        onArrowDown={state.onArrowDown}
      />
    </Box>
  );
}
