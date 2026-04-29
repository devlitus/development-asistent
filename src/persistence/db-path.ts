/**
 * db-path.ts — utilidad para obtener la ruta de la base de datos SQLite.
 *
 * Centraliza la convención de ruta para que tanto el servidor ACP como
 * el cliente TUI usen siempre el mismo fichero.
 *
 * Convención:
 *   - Windows: %APPDATA%\personal-asistent\data.db
 *   - Linux/macOS: ~/.local/share/personal-asistent/data.db
 */

import { homedir } from "os";
import { join } from "path";

const APP_NAME = "personal-asistent";

/**
 * Devuelve la ruta absoluta al fichero de base de datos SQLite.
 * Sigue la convención XDG en Unix y APPDATA en Windows.
 */
export function getDbPath(): string {
  if (process.platform === "win32") {
    const appData =
      process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
    return join(appData, APP_NAME, "data.db");
  }
  return join(homedir(), ".local", "share", APP_NAME, "data.db");
}
