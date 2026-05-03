/**
 * InputLine.tsx — INK-04
 *
 * Línea de input del usuario.
 * Acumula caracteres con useInput de Ink y llama onSubmit al presionar Enter.
 * Cuando está deshabilitado, muestra el prompt en gris y no acepta input.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

// ─── Props ────────────────────────────────────────────────────────────────────

interface InputLineProps {
  enabled: boolean;
  onSubmit: (text: string) => void;
  /** Callback de scroll — inyectado por InkInput a través de TuiAppState */
  onArrowUp?: () => void;
  onArrowDown?: () => void;
  /** Cuando está definido, el input entra en modo permiso (Y/n) */
  onPermissionResponse?: (answer: string) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function InputLine({ enabled, onSubmit, onArrowUp, onArrowDown, onPermissionResponse }: InputLineProps): React.ReactElement {
  const [buffer, setBuffer] = useState("");

  const isPermissionMode = Boolean(onPermissionResponse);

  useInput(
    (input, key) => {
      // Flechas de scroll — activas incluso cuando el input está pausado
      if (key.upArrow) { onArrowUp?.(); return; }
      if (key.downArrow) { onArrowDown?.(); return; }

      // Modo permiso: siempre captura input (inputEnabled puede ser false en otro modo)
      if (isPermissionMode && onPermissionResponse) {
        if (key.return) {
          const text = buffer.trim();
          setBuffer("");
          // Empty Enter → interpretado como "n" (denegar por defecto)
          onPermissionResponse(text || "n");
          return;
        }
        if (key.backspace || key.delete) {
          setBuffer((prev) => prev.slice(0, -1));
          return;
        }
        if (key.escape || key.ctrl || key.meta) return;
        setBuffer((prev) => prev + input);
        return;
      }

      if (!enabled) return;

      if (key.return) {
        const text = buffer.trim();
        setBuffer("");
        if (text) {
          onSubmit(text);
        }
        return;
      }

      if (key.backspace || key.delete) {
        setBuffer((prev) => prev.slice(0, -1));
        return;
      }

      // Ignorar teclas de control (escape, ctrl+*, etc.)
      if (key.escape || key.ctrl || key.meta) return;

      setBuffer((prev) => prev + input);
    },
    { isActive: true }, // siempre activo para capturar flechas
  );

  const promptSymbol = isPermissionMode ? "Y/n ›" : "❯";
  const promptColor  = isPermissionMode ? "yellow" : (enabled ? "cyan" : "gray");

  // M7: colorización del buffer en modo permiso
  const permissionBufferColor = (() => {
    if (!isPermissionMode) return undefined;
    const n = buffer.trim().toLowerCase();
    if (n.startsWith("y") || n.startsWith("s")) return "green";
    if (n.startsWith("n")) return "red";
    return "yellow";
  })();

  return (
    <Box>
      <Text color={promptColor} dimColor={!enabled && !isPermissionMode}>
        {promptSymbol}{" "}
      </Text>
      <Text color={isPermissionMode ? permissionBufferColor : undefined}>{buffer}</Text>
    </Box>
  );
}
