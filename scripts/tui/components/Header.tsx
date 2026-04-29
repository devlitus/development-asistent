/**
 * Header.tsx — INK-04
 *
 * Componente de cabecera del TUI.
 * Muestra la versión del asistente y un badge de estado con colores.
 */

import React from "react";
import { Box, Text } from "ink";
import type { TuiStatus } from "../types.ts";

// ─── Props ────────────────────────────────────────────────────────────────────

interface HeaderProps {
  version: string;
  status: TuiStatus;
}

// ─── Badge config ─────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<TuiStatus, { label: string; color: string }> = {
  idle:               { label: "[Listo]",            color: "green"  },
  thinking:           { label: "[Pensando...]",       color: "blue"   },
  waiting_permission: { label: "[Esperando permiso]", color: "yellow" },
  error:              { label: "[Error]",             color: "red"    },
  connecting:         { label: "[Conectando...]",     color: "yellow" },
};

// ─── Component ────────────────────────────────────────────────────────────────

export function Header({ version, status }: HeaderProps): React.ReactElement {
  const badge = STATUS_BADGE[status];

  return (
    <Box borderStyle="double" borderColor="cyan" justifyContent="space-between">
      <Text bold color="cyan">
        personal-asistent v{version}
      </Text>
      <Text color={badge.color}>{badge.label}</Text>
    </Box>
  );
}
