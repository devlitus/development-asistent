/**
 * db-path.test.ts
 *
 * Verifica que getDbPath() devuelva la ruta correcta según la plataforma,
 * y que sea coherente con la convención XDG / APPDATA.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { homedir } from "os";
import { join } from "path";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("getDbPath", () => {
  // Guardamos y restauramos las variables de entorno y process.platform
  let originalPlatform: string;
  let originalAppData: string | undefined;

  beforeEach(() => {
    originalPlatform = process.platform;
    originalAppData = process.env["APPDATA"];
  });

  afterEach(() => {
    // Restaurar platform
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    // Restaurar APPDATA
    if (originalAppData === undefined) {
      delete process.env["APPDATA"];
    } else {
      process.env["APPDATA"] = originalAppData;
    }
  });

  it("debería terminar siempre en 'data.db'", async () => {
    const { getDbPath } = await import("../../src/persistence/db-path.ts");
    const path = getDbPath();
    expect(path.endsWith("data.db")).toBe(true);
  });

  it("debería contener 'personal-asistent' en la ruta", async () => {
    const { getDbPath } = await import("../../src/persistence/db-path.ts");
    const path = getDbPath();
    expect(path).toContain("personal-asistent");
  });

  it("en Windows con APPDATA definido, usa APPDATA como base", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    process.env["APPDATA"] = "C:\\Users\\TestUser\\AppData\\Roaming";

    // Re-importar para que los cambios de platform/env sean efectivos
    const mod = await import("../../src/persistence/db-path.ts?windows-appdata");
    const path = mod.getDbPath();
    expect(path).toBe(
      join("C:\\Users\\TestUser\\AppData\\Roaming", "personal-asistent", "data.db")
    );
  });

  it("en Windows sin APPDATA, usa homedir como fallback", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    delete process.env["APPDATA"];

    const mod = await import("../../src/persistence/db-path.ts?windows-noappddata");
    const path = mod.getDbPath();
    expect(path).toBe(
      join(homedir(), "AppData", "Roaming", "personal-asistent", "data.db")
    );
  });

  it("en Unix, usa XDG ~/.local/share", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    const mod = await import("../../src/persistence/db-path.ts?linux");
    const path = mod.getDbPath();
    expect(path).toBe(
      join(homedir(), ".local", "share", "personal-asistent", "data.db")
    );
  });

  it("está exportado desde src/persistence/index.ts", async () => {
    const persistence = await import("../../src/persistence/index.ts");
    expect(typeof persistence.getDbPath).toBe("function");
  });
});
