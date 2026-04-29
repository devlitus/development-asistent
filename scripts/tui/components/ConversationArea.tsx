/**
 * ConversationArea.tsx — INK-04 / INK2-03
 *
 * Renderiza el historial de mensajes de la conversación.
 * Limita la cantidad de mensajes visibles a maxRows para no desbordar el terminal.
 * Si streamBuffer no está vacío, lo muestra al final como mensaje en curso.
 *
 * INK2-03: Mensajes kind="agent" se renderizan con markdown básico (Plan B manual,
 * ya que ink-markdown usa require() CJS incompatible con Bun/ESM).
 */

import React from "react";
import { Box, Text } from "ink";
import type { DisplayMessage } from "../ink-renderer.tsx";
import type { PermissionRequest } from "../types.ts";

// ─── Markdown parser ──────────────────────────────────────────────────────────

export type MarkdownLineStyle = "normal" | "h1" | "h2" | "h3" | "code";

export interface MarkdownLine {
  text: string;
  style: MarkdownLineStyle;
}

/**
 * Convierte un string markdown a un array de líneas con estilo.
 * Soporta: headers (#, ##, ###), bloques de código (``` o 4 espacios).
 * Nunca lanza — markdown incompleto se trata como texto normal.
 */
export function parseMarkdownLines(text: string): MarkdownLine[] {
  if (!text) return [];

  const rawLines = text.split("\n");
  const result: MarkdownLine[] = [];
  let inCodeBlock = false;

  for (const line of rawLines) {
    // Toggle de bloque de código
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      result.push({ text: line, style: "code" });
      continue;
    }

    if (inCodeBlock) {
      result.push({ text: line, style: "code" });
      continue;
    }

    // Indentación de 4 espacios → código
    if (line.startsWith("    ")) {
      result.push({ text: line, style: "code" });
      continue;
    }

    // Headers
    if (line.startsWith("### ")) {
      result.push({ text: line.slice(4), style: "h3" });
      continue;
    }
    if (line.startsWith("## ")) {
      result.push({ text: line.slice(3), style: "h2" });
      continue;
    }
    if (line.startsWith("# ")) {
      result.push({ text: line.slice(2), style: "h1" });
      continue;
    }

    // Texto normal (incluyendo markdown incompleto como **sin cerrar)
    result.push({ text: line, style: "normal" });
  }

  return result;
}

// ─── renderMarkdown ───────────────────────────────────────────────────────────

function renderMarkdown(text: string): React.ReactElement {
  const lines = parseMarkdownLines(text);

  if (lines.length === 0) {
    return <Text>{text}</Text>;
  }

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        switch (line.style) {
          case "h1":
            return <Text key={i} bold>{line.text}</Text>;
          case "h2":
            return <Text key={i} bold dimColor>{line.text}</Text>;
          case "h3":
            return <Text key={i} bold dimColor>{line.text}</Text>;
          case "code":
            return <Text key={i} color="green" dimColor>{line.text}</Text>;
          default:
            return <Text key={i}>{line.text}</Text>;
        }
      })}
    </Box>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface ConversationAreaProps {
  messages: DisplayMessage[];
  streamBuffer: string;
  maxRows?: number;
  scrollOffset: number;
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

const MessageLine = React.memo(function MessageLine({ msg }: { msg: DisplayMessage }): React.ReactElement | null {
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
        <Box>
          <Text color="green">Agent › </Text>
          {renderMarkdown(msg.text)}
        </Box>
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
});

// ─── Component ────────────────────────────────────────────────────────────────

export function ConversationArea({
  messages,
  streamBuffer,
  maxRows,
  scrollOffset,
}: ConversationAreaProps): React.ReactElement {
  const rows = maxRows ?? Math.max(1, (process.stdout.rows ?? 24) - 6);

  // Calcula cuántos mensajes mostrar teniendo en cuenta el streamBuffer
  const streamSlot = streamBuffer ? 1 : 0;
  const visibleCount = Math.max(1, rows - streamSlot);
  const totalMessages = messages.length;

  // scrollOffset=0 → últimos visibleCount mensajes
  // scrollOffset=N → desplazado N hacia atrás desde el final
  const clampedOffset = Math.min(scrollOffset, Math.max(0, totalMessages - visibleCount));
  const endIdx = totalMessages - clampedOffset;
  const startIdx = Math.max(0, endIdx - visibleCount);
  const visible = messages.slice(startIdx, endIdx);

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {clampedOffset > 0 && (
        <Text dimColor>↑ {clampedOffset} mensajes anteriores (↑/↓ para desplazar)</Text>
      )}
      {visible.map((msg, i) => (
        <MessageLine key={i} msg={msg} />
      ))}
      {streamBuffer ? (
        <Box>
          <Text color="green">Agent › </Text>
          {renderMarkdown(streamBuffer)}
        </Box>
      ) : null}
    </Box>
  );
}
