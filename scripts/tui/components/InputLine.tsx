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
}

// ─── Component ────────────────────────────────────────────────────────────────

export function InputLine({ enabled, onSubmit }: InputLineProps): React.ReactElement {
  const [buffer, setBuffer] = useState("");

  useInput(
    (input, key) => {
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
    { isActive: enabled },
  );

  return (
    <Box>
      <Text color={enabled ? "cyan" : "gray"} dimColor={!enabled}>
        ❯{" "}
      </Text>
      <Text>{buffer}</Text>
    </Box>
  );
}
