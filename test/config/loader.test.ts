/**
 * Tests for the config loader module.
 *
 * Tests cover:
 * - Default config when file doesn't exist
 * - Valid TOML with partial agents → merge with defaults
 * - Invalid TOML → throws with descriptive error
 * - ASISTENTE_CONFIG_PATH env var overrides path
 * - getConfig() caches result
 * - resetConfigCache() clears cache
 * - mcp.servers loaded correctly
 * - context.maxTokens invalid → Zod error
 * - provider invalid → Zod error
 * - model empty → Zod error
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join, sep } from "path";
import { writeFileSync, unlinkSync, existsSync, mkdirSync, symlinkSync } from "fs";
import { randomUUID } from "crypto";

import { loadConfig } from "../../src/config/loader.ts";
import { getConfig, resetConfigCache } from "../../src/config/index.ts";
import { DEFAULT_CONFIG } from "../../src/config/defaults.ts";

// ─── Helpers ──────────────────────────────────────────────────────

function tmpToml(content: string): string {
  const dir = join(tmpdir(), `config-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "config.toml");
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

const createdFiles: string[] = [];

function writeTmpToml(content: string): string {
  const path = tmpToml(content);
  createdFiles.push(path);
  return path;
}

// ─── Setup / Teardown ─────────────────────────────────────────────

beforeEach(() => {
  process.env.BUN_ENV = "test";
  resetConfigCache();
  // Clean env var if set by previous test
  delete process.env.ASISTENTE_CONFIG_PATH;
});

afterEach(() => {
  // Clean up temp files
  for (const f of createdFiles) {
    if (existsSync(f)) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  }
  createdFiles.length = 0;
  delete process.env.ASISTENTE_CONFIG_PATH;
  delete process.env.BUN_ENV;
});

// ─── loadConfig() ─────────────────────────────────────────────────

describe("loadConfig", () => {
  it("retorna defaults cuando el archivo no existe", () => {
    const config = loadConfig("/nonexistent/path/config.toml");
    expect(config.agents.orchestrator.provider).toBe("anthropic");
    expect(config.agents.orchestrator.model).toBe("claude-sonnet-4-5");
    expect(config.mcp.servers).toEqual([]);
    expect(config.context.maxTokens).toBe(100000);
    expect(config.context.summaryThreshold).toBe(0.7);
  });

  it("carga TOML válido con agents parciales y hace merge con defaults", () => {
    const toml = `
[agents.orchestrator]
provider = "openai"
model = "gpt-4o"
`;
    const path = writeTmpToml(toml);
    const config = loadConfig(path);

    // Overridden agent
    expect(config.agents.orchestrator.provider).toBe("openai");
    expect(config.agents.orchestrator.model).toBe("gpt-4o");

    // Default agents still present
    expect(config.agents.code.provider).toBe("anthropic");
    expect(config.agents.git.provider).toBe("anthropic");
  });

  it("carga TOML con mcp.servers correctamente", () => {
    const toml = `
[[mcp.servers]]
name = "filesystem"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
`;
    const path = writeTmpToml(toml);
    const config = loadConfig(path);

    expect(config.mcp.servers).toHaveLength(1);
    expect(config.mcp.servers[0].name).toBe("filesystem");
    expect(config.mcp.servers[0].command).toBe("npx");
    expect(config.mcp.servers[0].args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]);
  });

  it("carga TOML con mcp.servers con env opcional", () => {
    const toml = `
[[mcp.servers]]
name = "myserver"
command = "node"
args = ["server.js"]

[mcp.servers.env]
MY_VAR = "hello"
`;
    const path = writeTmpToml(toml);
    const config = loadConfig(path);

    expect(config.mcp.servers[0].env).toEqual({ MY_VAR: "hello" });
  });

  it("carga TOML con context.maxTokens personalizado", () => {
    const toml = `
[context]
maxTokens = 50000
summaryThreshold = 0.8
`;
    const path = writeTmpToml(toml);
    const config = loadConfig(path);

    expect(config.context.maxTokens).toBe(50000);
    expect(config.context.summaryThreshold).toBe(0.8);
  });

  it("lanza error descriptivo cuando el TOML tiene provider inválido", () => {
    const toml = `
[agents.orchestrator]
provider = "invalid-provider"
model = "some-model"
`;
    const path = writeTmpToml(toml);
    expect(() => loadConfig(path)).toThrow(/Invalid config/i);
  });

  it("lanza error descriptivo cuando model está vacío", () => {
    const toml = `
[agents.orchestrator]
provider = "anthropic"
model = ""
`;
    const path = writeTmpToml(toml);
    expect(() => loadConfig(path)).toThrow(/Invalid config/i);
  });

  it("lanza error cuando context.maxTokens es negativo", () => {
    const toml = `
[context]
maxTokens = -100
`;
    const path = writeTmpToml(toml);
    expect(() => loadConfig(path)).toThrow(/Invalid config/i);
  });

  it("lanza error cuando context.summaryThreshold está fuera de rango [0,1]", () => {
    const toml = `
[context]
summaryThreshold = 1.5
`;
    const path = writeTmpToml(toml);
    expect(() => loadConfig(path)).toThrow(/Invalid config/i);
  });

  it("usa ASISTENTE_CONFIG_PATH cuando está definida", () => {
    const toml = `
[agents.code]
provider = "ollama"
model = "codellama"
`;
    const path = writeTmpToml(toml);
    process.env.ASISTENTE_CONFIG_PATH = path;

    const config = loadConfig(); // no override path
    expect(config.agents.code.provider).toBe("ollama");
    expect(config.agents.code.model).toBe("codellama");
  });

  it("el parámetro overridePath tiene prioridad sobre ASISTENTE_CONFIG_PATH", () => {
    const toml1 = `
[agents.code]
provider = "ollama"
model = "codellama"
`;
    const toml2 = `
[agents.code]
provider = "openai"
model = "gpt-4o-mini"
`;
    const path1 = writeTmpToml(toml1);
    const path2 = writeTmpToml(toml2);
    process.env.ASISTENTE_CONFIG_PATH = path1;

    const config = loadConfig(path2); // explicit path wins
    expect(config.agents.code.provider).toBe("openai");
    expect(config.agents.code.model).toBe("gpt-4o-mini");
  });
});

// ─── getConfig() / resetConfigCache() ────────────────────────────

describe("getConfig", () => {
  it("retorna defaults cuando no hay archivo de config", () => {
    const config = getConfig("/nonexistent/path/config.toml");
    expect(config.agents.orchestrator.provider).toBe("anthropic");
  });

  it("cachea el resultado (misma referencia en segunda llamada)", () => {
    const path = writeTmpToml(`
[agents.orchestrator]
provider = "openai"
model = "gpt-4o"
`);
    const config1 = getConfig(path);
    const config2 = getConfig(path);
    expect(config1).toBe(config2); // same reference
  });

  it("resetConfigCache() limpia la caché y permite recargar", () => {
    const path = writeTmpToml(`
[agents.orchestrator]
provider = "openai"
model = "gpt-4o"
`);
    const config1 = getConfig(path);
    expect(config1.agents.orchestrator.provider).toBe("openai");

    resetConfigCache();

    const path2 = writeTmpToml(`
[agents.orchestrator]
provider = "ollama"
model = "llama3"
`);
    const config2 = getConfig(path2);
    expect(config2.agents.orchestrator.provider).toBe("ollama");
    expect(config1).not.toBe(config2);
  });
});

// ─── New tests (R1 fixes) ─────────────────────────────────────────

describe("loadConfig — nuevos tests R1", () => {
  it("lanza error cuando el TOML tiene sintaxis inválida", () => {
    // Corchete sin cerrar = error de parser TOML
    const path = writeTmpToml(`[agents.orchestrator\nprovider = "anthropic"`);
    expect(() => loadConfig(path)).toThrow();
  });

  it("merge parcial de agente: solo provider en TOML usa model del default", () => {
    const toml = `[agents.orchestrator]\nprovider = "openai"`;
    const path = writeTmpToml(toml);
    const config = loadConfig(path);
    expect(config.agents.orchestrator.provider).toBe("openai");
    expect(config.agents.orchestrator.model).toBe("claude-sonnet-4-5"); // modelo del default
  });

  it("acepta context.summaryThreshold = 0 (límite inferior válido)", () => {
    const path = writeTmpToml(`[context]\nsummaryThreshold = 0`);
    const config = loadConfig(path);
    expect(config.context.summaryThreshold).toBe(0);
  });

  it("acepta context.summaryThreshold = 1 (límite superior válido)", () => {
    const path = writeTmpToml(`[context]\nsummaryThreshold = 1`);
    const config = loadConfig(path);
    expect(config.context.summaryThreshold).toBe(1);
  });

  it("rechaza ASISTENTE_CONFIG_PATH con path traversal", () => {
    process.env.ASISTENTE_CONFIG_PATH = "/etc/passwd";
    expect(() => loadConfig()).toThrow(/outside allowed directories/i);
  });

  it("carga múltiples mcp.servers correctamente", () => {
    const toml = `
[[mcp.servers]]
name = "server1"
command = "node"

[[mcp.servers]]
name = "server2"
command = "python"
`;
    const path = writeTmpToml(toml);
    const config = loadConfig(path);
    expect(config.mcp.servers).toHaveLength(2);
    expect(config.mcp.servers[0].name).toBe("server1");
    expect(config.mcp.servers[1].name).toBe("server2");
  });
  it("lanza error cuando el archivo de config supera 1MB", () => {
    // Crear contenido > 1MB
    const bigContent = "# " + "x".repeat(1024 * 1024 + 100);
    const path = writeTmpToml(bigContent);
    expect(() => loadConfig(path)).toThrow(/exceeds maximum allowed size/i);
  });
});

// ─── DEFAULT_CONFIG ───────────────────────────────────────────────

describe("DEFAULT_CONFIG", () => {
  it("tiene todos los agentes de dominio con provider anthropic", () => {
    for (const agentKey of ["orchestrator", "code", "os", "docs", "git"]) {
      expect(DEFAULT_CONFIG.agents[agentKey]).toBeDefined();
      expect(DEFAULT_CONFIG.agents[agentKey].provider).toBe("anthropic");
    }
  });

  it("tiene mcp.servers vacío por defecto", () => {
    expect(DEFAULT_CONFIG.mcp.servers).toEqual([]);
  });

  it("tiene context con maxTokens y summaryThreshold", () => {
    expect(DEFAULT_CONFIG.context.maxTokens).toBe(100000);
    expect(DEFAULT_CONFIG.context.summaryThreshold).toBe(0.7);
  });
});

// ─── TEST-04: Edge cases adicionales ─────────────────────────────

describe("loadConfig — TEST-04: edge cases adicionales", () => {
  it("config con agente desconocido en agents → cargado sin error (extensible)", () => {
    // Un agente no conocido en el enum debe ser ignorado o cargado sin lanzar error
    const toml = `
[agents.orchestrator]
provider = "anthropic"
model = "claude-sonnet-4-5"

[agents.unknown_custom_agent]
provider = "anthropic"
model = "claude-haiku-3-5"
`;
    const path = writeTmpToml(toml);
    // No debe lanzar error — el schema debe ser extensible o ignorar campos extra
    expect(() => loadConfig(path)).not.toThrow();
    const config = loadConfig(path);
    // Los agentes conocidos siguen funcionando
    expect(config.agents.orchestrator.provider).toBe("anthropic");
  });

  it("config sin sección [context] → context usa valores por defecto tras merge", () => {
    const toml = `
[agents.orchestrator]
provider = "openai"
model = "gpt-4o"
`;
    const path = writeTmpToml(toml);
    const config = loadConfig(path);
    // Sin sección [context], debe usar defaults
    expect(config.context).toBeDefined();
    expect(config.context.maxTokens).toBe(DEFAULT_CONFIG.context.maxTokens);
    expect(config.context.summaryThreshold).toBe(DEFAULT_CONFIG.context.summaryThreshold);
  });

  it("maxTokens y summaryThreshold siempre definidos tras merge (nunca undefined)", () => {
    // Config completamente vacía
    const path = writeTmpToml("");
    const config = loadConfig(path);
    expect(config.context.maxTokens).not.toBeUndefined();
    expect(config.context.summaryThreshold).not.toBeUndefined();
    expect(typeof config.context.maxTokens).toBe("number");
    expect(typeof config.context.summaryThreshold).toBe("number");
  });

  it("config con servers array vacío [] → sin error", () => {
    const toml = `
[mcp]
servers = []
`;
    const path = writeTmpToml(toml);
    expect(() => loadConfig(path)).not.toThrow();
    const config = loadConfig(path);
    expect(config.mcp.servers).toEqual([]);
  });
});

// ─── sanitizeConfigPath — symlink security (SEC-06) ──────────────

/** Try to create a symlink synchronously; return false if OS denies permission. */
function tryCreateSymlinkSync(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath);
    return true;
  } catch {
    return false;
  }
}

describe("sanitizeConfigPath — symlink security (SEC-06)", () => {
  beforeEach(() => {
    process.env.BUN_ENV = "test";
    resetConfigCache();
    delete process.env.ASISTENTE_CONFIG_PATH;
  });

  afterEach(() => {
    delete process.env.ASISTENTE_CONFIG_PATH;
    delete process.env.BUN_ENV;
  });

  it("config path legítimo que existe → cargado correctamente", () => {
    const toml = `
[agents.orchestrator]
provider = "openai"
model = "gpt-4o"
`;
    const path = writeTmpToml(toml);
    const config = loadConfig(path);
    expect(config.agents.orchestrator.provider).toBe("openai");
  });

  it("symlink dentro del directorio permitido apuntando a otro archivo en tmpdir → permitido", () => {
    const toml = `
[agents.orchestrator]
provider = "openai"
model = "gpt-4o"
`;
    const realPath = writeTmpToml(toml);
    const realDir = realPath.substring(0, realPath.lastIndexOf(sep));

    // Create symlink in same tmpdir subdir
    const linkPath = join(realDir, "config-link.toml");
    const created = tryCreateSymlinkSync(realPath, linkPath);
    if (!created) {
      // Skip gracefully on Windows without symlink permissions
      return;
    }
    createdFiles.push(linkPath);

    process.env.ASISTENTE_CONFIG_PATH = linkPath;
    const config = loadConfig();
    expect(config.agents.orchestrator.provider).toBe("openai");
  });

  it("symlink que apunta fuera del directorio de config → bloqueado", () => {
    // Create a real file outside tmpdir (use a known system file)
    const outsideTarget = process.platform === "win32"
      ? "C:\\Windows\\System32\\drivers\\etc\\hosts"
      : "/etc/hosts";

    // Create symlink inside tmpdir pointing outside
    const dir = join(tmpdir(), `config-symlink-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const linkPath = join(dir, "evil-config.toml");

    const created = tryCreateSymlinkSync(outsideTarget, linkPath);
    if (!created) {
      // Skip gracefully on Windows without symlink permissions
      return;
    }
    createdFiles.push(linkPath);

    process.env.ASISTENTE_CONFIG_PATH = linkPath;
    expect(() => loadConfig()).toThrow(/outside allowed directories/i);
  });

  it("config path que no existe (primera ejecución) → retorna defaults", () => {
    const config = loadConfig("/nonexistent/config.toml");
    expect(config.agents.orchestrator.provider).toBe("anthropic");
    expect(config.mcp.servers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SEC-10: userAgent campo opcional en ConfigSchema
// ---------------------------------------------------------------------------

import { ConfigSchema } from "../../src/config/schema.ts";

describe("ConfigSchema — campo userAgent opcional (SEC-10)", () => {
  it("acepta config sin userAgent → undefined", () => {
    const result = ConfigSchema.parse({});
    expect(result.userAgent).toBeUndefined();
  });

  it("acepta config con userAgent personalizado", () => {
    const result = ConfigSchema.parse({ userAgent: "MyBot/1.0" });
    expect(result.userAgent).toBe("MyBot/1.0");
  });

  it("userAgent vacío es aceptado por Zod (string vacío)", () => {
    const result = ConfigSchema.parse({ userAgent: "" });
    expect(result.userAgent).toBe("");
  });
});
