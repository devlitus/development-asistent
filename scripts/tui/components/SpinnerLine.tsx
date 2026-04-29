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
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SpinnerLine({ active }: SpinnerLineProps): React.ReactElement {
  if (active) {
    return (
      <Box>
        <Spinner type="dots" />
        <Text color="blue"> Pensando...</Text>
      </Box>
    );
  }

  return <Box height={1} />;
}
