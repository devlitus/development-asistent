/**
 * ConversationArea.tsx — INK-04
 *
 * Renderiza el historial de mensajes de la conversación.
 * Limita la cantidad de mensajes visibles a maxRows para no desbordar el terminal.
 * Si streamBuffer no está vacío, lo muestra al final como mensaje en curso.
 */

import React from "react";
import { Box, Text } from "ink";
import type { DisplayMessage } from "../ink-renderer.tsx";
import type { PermissionRequest } from "../types.ts";

// ─── Props ────────────────────────────────────────────────────────────────────

interface ConversationAreaProps {
  messages: DisplayMessage[];
  streamBuffer: string;
  maxRows?: number;
}

// ─── PermissionBlock ──────────────────────────────────────────────────────────

function PermissionBlock({ req }: { req: PermissionRequest }): React.ReactElement {
  const inputStr = (() => {
    try { return JSON.stringify(req.input, null, 2); }
    catch { return "[circular]"; }
  })();
  const truncated = inputStr.length > 500 ? inputStr.slice(0, 500) + "\n… (truncado)" : inputStr;
  return (
    <Box borderStyle="single" borderColor="yellow" flexDirection="column">
      <Text>
        Tool: <Text color="red">{req.toolName}</Text>
      </Text>
      <Text>Description: {req.description}</Text>
      <Text dimColor>{truncated}</Text>
      <Text color="yellow">Allow? [Y/n]</Text>
    </Box>
  );
}

// ─── MessageLine ──────────────────────────────────────────────────────────────

function MessageLine({ msg }: { msg: DisplayMessage }): React.ReactElement | null {
  switch (msg.kind) {
    case "user":
      return (
        <Text>
          <Text color="cyan">You › </Text>
          {msg.text}
        </Text>
      );
    case "agent":
      return (
        <Text>
          <Text color="green">Agent › </Text>
          {msg.text}
        </Text>
      );
    case "system":
      return (
        <Text color="gray" italic>
          {msg.text}
        </Text>
      );
    case "error":
      return <Text color="red">✖ Error: {msg.text}</Text>;
    case "routing":
      return (
        <Text color="gray" dimColor>
          → {msg.agentName}
        </Text>
      );
    case "tool_call":
      return <Text color="yellow">⚙ Tool call: {msg.name}</Text>;
    case "tool_result":
      return (
        <Text color="gray" dimColor>
          ↩ {msg.name}: {msg.status}
        </Text>
      );
    case "separator":
      return <Text dimColor>{"─".repeat(40)}</Text>;
    case "permission":
      return <PermissionBlock req={msg.req} />;
    default: {
      const _exhaustive: never = msg;
      void _exhaustive;
      return null;
    }
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ConversationArea({
  messages,
  streamBuffer,
  maxRows,
}: ConversationAreaProps): React.ReactElement {
  const rows = maxRows ?? Math.max(1, (process.stdout.rows ?? 24) - 6);

  // Calcula cuántos mensajes mostrar teniendo en cuenta el streamBuffer
  const streamSlot = streamBuffer ? 1 : 0;
  const visibleCount = Math.max(0, rows - streamSlot);
  const visible = messages.slice(-visibleCount);

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {visible.map((msg, i) => (
        <MessageLine key={i} msg={msg} />
      ))}
      {streamBuffer ? (
        <Text>
          <Text color="green">Agent › </Text>
          {streamBuffer}
        </Text>
      ) : null}
    </Box>
  );
}
