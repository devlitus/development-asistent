/**
 * SpinnerLine.tsx — INK-04
 *
 * Línea de spinner que muestra animación cuando el agente está pensando.
 * Cuando está inactivo, reserva el espacio para evitar saltos de layout.
 */

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

// ─── Props ────────────────────────────────────────────────────────────────────

interface SpinnerLineProps {
  active: boolean;
  label?: string; // M4: label dinámico
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SpinnerLine({ active, label }: SpinnerLineProps): React.ReactElement {
  if (active) {
    return (
      <Box>
        <Spinner type="dots" />
        <Text color="blue"> {label ?? "Pensando..."}</Text>
      </Box>
    );
  }

  return <Box height={1} />;
}
