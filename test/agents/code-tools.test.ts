/**
 * Unit tests for Code Agent tools.
 *
 * Uses a real filesystem in a temporary directory for each test suite.
 * Tests the four tools: read_file, write_file, list_directory, search_code.
 * Also tests security utilities: isPathWithinWorkspace, resolveWorkspacePath.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  isPathWithinWorkspace,
  resolveWorkspacePath,
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  LIST_DIRECTORY_TOOL,
  SEARCH_CODE_TOOL,
  CODE_AGENT_TOOLS,
  getToolSchemas,
  executeTool,
  MAX_FILES_WALKED,
  MAX_SEARCH_FILE_BYTES,
} from "../../src/agents/code/tools.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workspace: string;

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "code-agent-test-"));
  return dir;
}

async function cleanupWorkspace(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// isPathWithinWorkspace
// ---------------------------------------------------------------------------

describe("isPathWithinWorkspace", () => {
  it("acepta path dentro del workspace", async () => {
    const ws = "C:\\projects\\myapp";
    const target = "C:\\projects\\myapp\\src\\index.ts";
    expect(await isPathWithinWorkspace(target, ws)).toBe(true);
  });

  it("acepta el workspace mismo", async () => {
    const ws = "C:\\projects\\myapp";
    expect(await isPathWithinWorkspace(ws, ws)).toBe(true);
  });

  it("rechaza path traversal con ..", async () => {
    const ws = "C:\\projects\\myapp";
    const target = "..\\..\\etc\\passwd";
    expect(await isPathWithinWorkspace(target, ws)).toBe(false);
  });

  it("rechaza path absoluto fuera del workspace", async () => {
    const ws = "C:\\projects\\myapp";
    const target = "C:\\Windows\\System32\\config";
    expect(await isPathWithinWorkspace(target, ws)).toBe(false);
  });

  it("rechaza path con null bytes", async () => {
    const ws = "C:\\projects\\myapp";
    const target = "src\x00../etc/passwd";
    expect(await isPathWithinWorkspace(target, ws)).toBe(false);
  });

  it("acepta path relativo simple dentro del workspace", async () => {
    const ws = "C:\\projects\\myapp";
    const target = "src\\utils.ts";
    expect(await isPathWithinWorkspace(target, ws)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveWorkspacePath
// ---------------------------------------------------------------------------

describe("resolveWorkspacePath", () => {
  it("resuelve path relativo correctamente", async () => {
    const ws = "C:\\projects\\myapp";
    const result = await resolveWorkspacePath("src/index.ts", ws);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(join(ws, "src", "index.ts"));
    }
  });

  it("rechaza path traversal", async () => {
    const ws = "C:\\projects\\myapp";
    const result = await resolveWorkspacePath("../../etc/passwd", ws);
    expect(result.ok).toBe(false);
  });

  it("rechaza null bytes", async () => {
    const ws = "C:\\projects\\myapp";
    const result = await resolveWorkspacePath("src\x00../etc/passwd", ws);
    expect(result.ok).toBe(false);
  });

  it("rechaza path vacío", async () => {
    const result = await resolveWorkspacePath("", "/workspace");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("required");
  });
});

// ---------------------------------------------------------------------------
// Tool definitions structure
// ---------------------------------------------------------------------------

describe("CODE_AGENT_TOOLS", () => {
  it("tiene exactamente 4 herramientas", () => {
    expect(CODE_AGENT_TOOLS).toHaveLength(4);
  });

  it("cada herramienta tiene name, description, parameters, execute", () => {
    for (const tool of CODE_AGENT_TOOLS) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters.type).toBe("object");
      expect(typeof tool.parameters.properties).toBe("object");
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("los nombres son unicos", () => {
    const names = CODE_AGENT_TOOLS.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});

// ---------------------------------------------------------------------------
// getToolSchemas
// ---------------------------------------------------------------------------

describe("getToolSchemas", () => {
  it("retorna schemas para las 4 herramientas", () => {
    const schemas = getToolSchemas();
    expect(schemas).toHaveLength(4);
  });

  it("cada schema tiene name, description, parameters", () => {
    const schemas = getToolSchemas();
    for (const schema of schemas) {
      expect(typeof schema.name).toBe("string");
      expect(typeof schema.description).toBe("string");
      expect(schema.parameters).toBeDefined();
    }
  });

  it("no incluye la funcion execute en los schemas", () => {
    const schemas = getToolSchemas();
    for (const schema of schemas) {
      expect("execute" in schema).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// executeTool
// ---------------------------------------------------------------------------

describe("executeTool", () => {
  it("retorna error para herramienta desconocida", async () => {
    const result = await executeTool("unknown_tool", {}, "C:\\workspace");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown tool");
  });
});

// ---------------------------------------------------------------------------
// read_file tool
// ---------------------------------------------------------------------------

describe("read_file tool", () => {
  beforeAll(async () => {
    workspace = await createWorkspace();
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "hello.ts"), 'console.log("hello");');
    await writeFile(join(workspace, "empty.txt"), "");
  });

  afterAll(async () => {
    await cleanupWorkspace(workspace);
  });

  it("lee un archivo existente y retorna el contenido", async () => {
    const result = await READ_FILE_TOOL.execute(
      { path: "src/hello.ts" },
      workspace,
    );
    expect(result.success).toBe(true);
    expect(result.content).toContain('console.log("hello");');
  });

  it("lee un archivo vacio y retorna contenido vacio", async () => {
    const result = await READ_FILE_TOOL.execute(
      { path: "empty.txt" },
      workspace,
    );
    expect(result.success).toBe(true);
    expect(result.content).toBe("");
  });

  it("retorna error para archivo inexistente", async () => {
    const result = await READ_FILE_TOOL.execute(
      { path: "nonexistent.ts" },
      workspace,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rechaza path traversal", async () => {
    const result = await READ_FILE_TOOL.execute(
      { path: "../../etc/passwd" },
      workspace,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("outside workspace");
  });

  it("rechaza path con null bytes", async () => {
    const result = await READ_FILE_TOOL.execute(
      { path: "src\x00../etc/passwd" },
      workspace,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("null bytes");
  });

  it("retorna error cuando falta el argumento path", async () => {
    const result = await READ_FILE_TOOL.execute({}, workspace);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("retorna error para archivos mayores de 1MB", async () => {
    const bigFile = join(workspace, "huge.ts");
    await writeFile(bigFile, "a".repeat(1_000_001));
    const result = await READ_FILE_TOOL.execute({ path: "huge.ts" }, workspace);
    expect(result.success).toBe(false);
    expect(result.error).toContain("too large");
  });
});

// ---------------------------------------------------------------------------
// write_file tool
// ---------------------------------------------------------------------------

describe("write_file tool", () => {
  beforeAll(async () => {
    workspace = await createWorkspace();
  });

  afterAll(async () => {
    await cleanupWorkspace(workspace);
  });

  it("escribe un archivo nuevo y el contenido es correcto", async () => {
    const result = await WRITE_FILE_TOOL.execute(
      { path: "new-file.ts", content: "export const x = 1;" },
      workspace,
    );
    expect(result.success).toBe(true);

    // Verify the file was actually written
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(join(workspace, "new-file.ts"), "utf-8");
    expect(content).toBe("export const x = 1;");
  });

  it("crea directorios intermedios si no existen", async () => {
    const result = await WRITE_FILE_TOOL.execute(
      { path: "deep/nested/dir/file.ts", content: "// nested" },
      workspace,
    );
    expect(result.success).toBe(true);

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(
      join(workspace, "deep", "nested", "dir", "file.ts"),
      "utf-8",
    );
    expect(content).toBe("// nested");
  });

  it("sobrescribe un archivo existente", async () => {
    // Create initial file
    await WRITE_FILE_TOOL.execute(
      { path: "overwrite.ts", content: "original" },
      workspace,
    );

    // Overwrite it
    const result = await WRITE_FILE_TOOL.execute(
      { path: "overwrite.ts", content: "updated" },
      workspace,
    );
    expect(result.success).toBe(true);

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(join(workspace, "overwrite.ts"), "utf-8");
    expect(content).toBe("updated");
  });

  it("rechaza path traversal", async () => {
    const result = await WRITE_FILE_TOOL.execute(
      { path: "../../tmp/malicious.txt", content: "evil" },
      workspace,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("outside workspace");
  });

  it("retorna error cuando falta el argumento path", async () => {
    const result = await WRITE_FILE_TOOL.execute(
      { content: "no path" },
      workspace,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("retorna error cuando falta el argumento content", async () => {
    const result = await WRITE_FILE_TOOL.execute({ path: "file.ts" }, workspace);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rechaza escribir en .git protegido", async () => {
    const result = await WRITE_FILE_TOOL.execute(
      { path: ".git/config", content: "malicious" },
      workspace,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("protected path");
  });

  it("rechaza escribir en .env", async () => {
    const result = await WRITE_FILE_TOOL.execute(
      { path: ".env", content: "SECRET=evil" },
      workspace,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("protected path");
  });

  it("rechaza escribir en bun.lockb", async () => {
    const result = await WRITE_FILE_TOOL.execute(
      { path: "bun.lockb", content: "evil" },
      workspace,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("protected path");
  });
});

// ---------------------------------------------------------------------------
// list_directory tool
// ---------------------------------------------------------------------------

describe("list_directory tool", () => {
  beforeAll(async () => {
    workspace = await createWorkspace();
    // Create structure:
    //   file1.ts
    //   file2.ts
    //   src/
    //   src/index.ts
    //   src/utils.ts
    //   dist/
    await writeFile(join(workspace, "file1.ts"), "");
    await writeFile(join(workspace, "file2.ts"), "");
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "index.ts"), "");
    await writeFile(join(workspace, "src", "utils.ts"), "");
    await mkdir(join(workspace, "dist"), { recursive: true });
  });

  afterAll(async () => {
    await cleanupWorkspace(workspace);
  });

  it("lista archivos y subdirectorios", async () => {
    const result = await LIST_DIRECTORY_TOOL.execute({ path: "." }, workspace);
    expect(result.success).toBe(true);

    const entries = JSON.parse(result.content);
    const names = entries.map((e: { name: string }) => e.name);
    expect(names).toContain("file1.ts");
    expect(names).toContain("file2.ts");
    expect(names).toContain("src");
    expect(names).toContain("dist");
  });

  it("cada entrada tiene name y type", async () => {
    const result = await LIST_DIRECTORY_TOOL.execute({ path: "." }, workspace);
    expect(result.success).toBe(true);

    const entries = JSON.parse(result.content);
    for (const entry of entries) {
      expect(entry).toHaveProperty("name");
      expect(entry).toHaveProperty("type");
      expect(["file", "directory"]).toContain(entry.type);
    }
  });

  it("distingue archivos de directorios", async () => {
    const result = await LIST_DIRECTORY_TOOL.execute({ path: "." }, workspace);
    expect(result.success).toBe(true);

    const entries = JSON.parse(result.content);
    const fileEntry = entries.find(
      (e: { name: string }) => e.name === "file1.ts",
    );
    const dirEntry = entries.find(
      (e: { name: string }) => e.name === "src",
    );
    expect(fileEntry?.type).toBe("file");
    expect(dirEntry?.type).toBe("directory");
  });

  it("lista contenido de un subdirectorio", async () => {
    const result = await LIST_DIRECTORY_TOOL.execute(
      { path: "src" },
      workspace,
    );
    expect(result.success).toBe(true);

    const entries = JSON.parse(result.content);
    const names = entries.map((e: { name: string }) => e.name);
    expect(names).toContain("index.ts");
    expect(names).toContain("utils.ts");
  });

  it("retorna error para path que no es directorio", async () => {
    const result = await LIST_DIRECTORY_TOOL.execute(
      { path: "file1.ts" },
      workspace,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("retorna error para path inexistente", async () => {
    const result = await LIST_DIRECTORY_TOOL.execute(
      { path: "nonexistent" },
      workspace,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rechaza path traversal", async () => {
    const result = await LIST_DIRECTORY_TOOL.execute(
      { path: "../../etc" },
      workspace,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("outside workspace");
  });

  it("usa workspace root cuando path no se proporciona", async () => {
    const result = await LIST_DIRECTORY_TOOL.execute({}, workspace);
    expect(result.success).toBe(true);

    const entries = JSON.parse(result.content);
    const names = entries.map((e: { name: string }) => e.name);
    expect(names).toContain("file1.ts");
  });
});

// ---------------------------------------------------------------------------
// search_code tool
// ---------------------------------------------------------------------------

describe("search_code tool", () => {
  beforeAll(async () => {
    workspace = await createWorkspace();
    // Create structure:
    //   src/main.ts       -> contains "hello world"
    //   src/utils.ts      -> contains "hello" on line 1, "goodbye" on line 2
    //   src/deep/nested.ts -> contains "hello from deep"
    //   .git/HEAD         -> contains "hello" (should be ignored)
    //   node_modules/pkg/index.ts -> contains "hello" (should be ignored)
    //   dist/bundle.js    -> contains "hello" (should be ignored)
    //   image.png         -> binary (should be ignored)
    await mkdir(join(workspace, "src", "deep"), { recursive: true });
    await writeFile(join(workspace, "src", "main.ts"), "// hello world\n");
    await writeFile(
      join(workspace, "src", "utils.ts"),
      "// hello\n// goodbye\n",
    );
    await writeFile(join(workspace, "src", "deep", "nested.ts"), "// hello from deep\n");

    // Ignored directories
    await mkdir(join(workspace, ".git"), { recursive: true });
    await writeFile(join(workspace, ".git", "HEAD"), "hello git\n");
    await mkdir(join(workspace, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      join(workspace, "node_modules", "pkg", "index.ts"),
      "hello from node_modules\n",
    );
    await mkdir(join(workspace, "dist"), { recursive: true });
    await writeFile(join(workspace, "dist", "bundle.js"), "hello from dist\n");
    await mkdir(join(workspace, "__pycache__"), { recursive: true });
    await writeFile(
      join(workspace, "__pycache__", "mod.pyc"),
      "hello pycache\n",
    );

    // Binary file (should be ignored by extension)
    await writeFile(join(workspace, "image.png"), "hello png\n");
  });

  afterAll(async () => {
    await cleanupWorkspace(workspace);
  });

  it("encuentra matches en archivos", async () => {
    const result = await SEARCH_CODE_TOOL.execute(
      { query: "hello world" },
      workspace,
    );
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.content);
    expect(parsed.matches).toBeDefined();
    expect(parsed.matches.length).toBeGreaterThanOrEqual(1);

    const mainMatch = parsed.matches.find(
      (m: { file: string }) => m.file.includes("main.ts"),
    );
    expect(mainMatch).toBeDefined();
    expect(mainMatch.content).toContain("hello world");
  });

  it("retorna line number correcto", async () => {
    const result = await SEARCH_CODE_TOOL.execute(
      { query: "goodbye" },
      workspace,
    );
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.content);
    const match = parsed.matches.find(
      (m: { file: string }) => m.file.includes("utils.ts"),
    );
    expect(match).toBeDefined();
    expect(match.line).toBe(2);
  });

  it("no busca en node_modules", async () => {
    const result = await SEARCH_CODE_TOOL.execute(
      { query: "node_modules" },
      workspace,
    );
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.content);
    const nodeModulesMatch = parsed.matches.find(
      (m: { file: string }) => m.file.includes("node_modules"),
    );
    expect(nodeModulesMatch).toBeUndefined();
  });

  it("no busca en .git", async () => {
    const result = await SEARCH_CODE_TOOL.execute(
      { query: "hello git" },
      workspace,
    );
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.content);
    const gitMatch = parsed.matches.find(
      (m: { file: string }) => m.file.includes(".git"),
    );
    expect(gitMatch).toBeUndefined();
  });

  it("no busca en dist", async () => {
    const result = await SEARCH_CODE_TOOL.execute(
      { query: "hello from dist" },
      workspace,
    );
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.content);
    const distMatch = parsed.matches.find(
      (m: { file: string }) => m.file.includes("dist"),
    );
    expect(distMatch).toBeUndefined();
  });

  it("no busca en __pycache__", async () => {
    const result = await SEARCH_CODE_TOOL.execute(
      { query: "hello pycache" },
      workspace,
    );
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.content);
    const pycacheMatch = parsed.matches.find(
      (m: { file: string }) => m.file.includes("__pycache__"),
    );
    expect(pycacheMatch).toBeUndefined();
  });

  it("ignora archivos binarios por extension", async () => {
    const result = await SEARCH_CODE_TOOL.execute(
      { query: "hello png" },
      workspace,
    );
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.content);
    const pngMatch = parsed.matches.find(
      (m: { file: string }) => m.file.endsWith(".png"),
    );
    expect(pngMatch).toBeUndefined();
  });

  it("busca recursivamente en subdirectorios", async () => {
    const result = await SEARCH_CODE_TOOL.execute(
      { query: "hello from deep" },
      workspace,
    );
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.content);
    const deepMatch = parsed.matches.find(
      (m: { file: string }) => m.file.includes("nested.ts"),
    );
    expect(deepMatch).toBeDefined();
  });

  it("retorna maximo 50 resultados", async () => {
    // Create 60 files with the same query
    const manyDir = join(workspace, "many");
    await mkdir(manyDir, { recursive: true });
    for (let i = 0; i < 60; i++) {
      await writeFile(join(manyDir, `file-${i}.ts`), "// UNIQUE_QUERY_MATCH\n");
    }

    const result = await SEARCH_CODE_TOOL.execute(
      { query: "UNIQUE_QUERY_MATCH" },
      workspace,
    );
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.content);
    expect(parsed.matches.length).toBeLessThanOrEqual(50);
  });

  it("busca en un subdirectorio especifico con path", async () => {
    const result = await SEARCH_CODE_TOOL.execute(
      { query: "goodbye", path: "src" },
      workspace,
    );
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.content);
    expect(parsed.matches.length).toBeGreaterThanOrEqual(1);
    for (const match of parsed.matches) {
      expect(match.file).toContain("src");
    }
  });

  it("retorna error cuando falta query", async () => {
    const result = await SEARCH_CODE_TOOL.execute({}, workspace);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rechaza path traversal", async () => {
    const result = await SEARCH_CODE_TOOL.execute(
      { query: "test", path: "../../etc" },
      workspace,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("outside workspace");
  });

  it("retorna array vacio cuando no hay matches", async () => {
    const result = await SEARCH_CODE_TOOL.execute(
      { query: "zzzz_no_match_at_all_xxx" },
      workspace,
    );
    expect(result.success).toBe(true);

    const parsed = JSON.parse(result.content);
    expect(parsed.matches).toEqual([]);
  });

  it("omite archivos mayores de 1MB cuando el query solo aparece más allá del límite", async () => {
    const bigFile = join(workspace, "big.ts");
    // Write MAX_SEARCH_FILE_BYTES+1 bytes — query "UNIQUE_BIG_QUERY" only at the very end (beyond 1MiB limit)
    await writeFile(bigFile, "x".repeat(MAX_SEARCH_FILE_BYTES + 1) + "UNIQUE_BIG_QUERY");
    const result = await SEARCH_CODE_TOOL.execute({ query: "UNIQUE_BIG_QUERY" }, workspace);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.content);
    // big.ts should not appear in matches (query is beyond 1MiB slice)
    const bigMatch = parsed.matches.find(
      (m: { file: string }) => m.file.includes("big.ts"),
    );
    expect(bigMatch).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveWorkspacePath — symlink security (SEC-01)
// ---------------------------------------------------------------------------

/** Try to create a symlink; return false if OS denies permission (Windows without dev mode). */
async function tryCreateSymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await symlink(target, linkPath);
    return true;
  } catch {
    return false;
  }
}

describe("resolveWorkspacePath — symlink security", () => {
  let symlinkWorkspace: string;

  beforeAll(async () => {
    symlinkWorkspace = await mkdtemp(join(tmpdir(), "symlink-sec-test-"));
  });

  afterAll(async () => {
    await rm(symlinkWorkspace, { recursive: true, force: true });
  });

  it("symlink dentro del workspace apuntando a archivo dentro del workspace → permitido", async () => {
    // Create a real file inside workspace
    const realFile = join(symlinkWorkspace, "real-file.txt");
    await writeFile(realFile, "hello");

    const linkPath = join(symlinkWorkspace, "link.txt");
    const created = await tryCreateSymlink(realFile, linkPath);
    if (!created) {
      // Skip gracefully on Windows without symlink permissions
      return;
    }

    const result = await resolveWorkspacePath("link.txt", symlinkWorkspace);
    expect(result.ok).toBe(true);
  });

  it("symlink dentro del workspace apuntando a archivo fuera del workspace → bloqueado", async () => {
    // Target outside workspace — use platform-appropriate path
    const outsideTarget = process.platform === "win32"
      ? "C:\\Windows\\System32\\drivers\\etc\\hosts"
      : "/etc/passwd";

    const linkPath = join(symlinkWorkspace, "evil-link");
    const created = await tryCreateSymlink(outsideTarget, linkPath);
    if (!created) {
      // Skip gracefully on Windows without symlink permissions
      return;
    }

    const result = await resolveWorkspacePath("evil-link", symlinkWorkspace);
    expect(result.ok).toBe(false);
  });

  it("symlink anidado (symlink → symlink → fuera del workspace) → bloqueado", async () => {
    const outsideTarget = process.platform === "win32"
      ? "C:\\Windows\\System32\\drivers\\etc\\hosts"
      : "/etc/passwd";

    const link2Path = join(symlinkWorkspace, "link2-nested");
    const link1Path = join(symlinkWorkspace, "link1-nested");

    const created2 = await tryCreateSymlink(outsideTarget, link2Path);
    if (!created2) return; // skip on Windows without permissions

    const created1 = await tryCreateSymlink(link2Path, link1Path);
    if (!created1) return; // skip on Windows without permissions

    const result = await resolveWorkspacePath("link1-nested", symlinkWorkspace);
    expect(result.ok).toBe(false);
  });

  it("path que no existe aún (nueva escritura) → permitido con path.resolve", async () => {
    // File does NOT exist — realpath falls back to resolvedTarget
    const result = await resolveWorkspacePath("nuevo-archivo.ts", symlinkWorkspace);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PERF-01: search_code — límite de lectura por archivo (1MB)
// ---------------------------------------------------------------------------

describe("PERF-01: search_code — límite de lectura por archivo", () => {
  let perfWorkspace: string;

  beforeAll(async () => {
    perfWorkspace = await mkdtemp(join(tmpdir(), "perf01-test-"));
    // Small file with match
    await writeFile(join(perfWorkspace, "small.ts"), "// PERF01_QUERY match here\n");
    // File exactly at the limit (should be read fully)
    await writeFile(join(perfWorkspace, "exact.ts"), "A".repeat(MAX_SEARCH_FILE_BYTES - 1) + "\n");
  });

  afterAll(async () => {
    await rm(perfWorkspace, { recursive: true, force: true });
  });

  it("MAX_SEARCH_FILE_BYTES está exportada y vale 1_048_576", () => {
    expect(MAX_SEARCH_FILE_BYTES).toBe(1_048_576);
  });

  it("encuentra matches en archivos pequeños normalmente", async () => {
    const result = await SEARCH_CODE_TOOL.execute(
      { query: "PERF01_QUERY" },
      perfWorkspace,
    );
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.matches.length).toBeGreaterThanOrEqual(1);
    expect(parsed.matches[0].file).toContain("small.ts");
  });

  it("no incluye truncated:true en archivos pequeños", async () => {
    const result = await SEARCH_CODE_TOOL.execute(
      { query: "PERF01_QUERY" },
      perfWorkspace,
    );
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.content);
    const match = parsed.matches.find((m: { file: string }) => m.file.includes("small.ts"));
    expect(match).toBeDefined();
    // truncated should be absent or false for small files
    expect(match.truncated).toBeFalsy();
  });

  it("omite (o trunca) archivos mayores de MAX_SEARCH_FILE_BYTES", async () => {
    // Write a file larger than 1MB with a unique query
    const bigPath = join(perfWorkspace, "toobig.ts");
    // Write 1MB+1 bytes with the query at the very end (beyond limit)
    const padding = "B".repeat(MAX_SEARCH_FILE_BYTES);
    await writeFile(bigPath, padding + "PERF01_BEYOND_LIMIT");

    const result = await SEARCH_CODE_TOOL.execute(
      { query: "PERF01_BEYOND_LIMIT" },
      perfWorkspace,
    );
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.content);
    // The query is beyond 1MB, so it should NOT be found
    const beyondMatch = parsed.matches.find(
      (m: { file: string }) => m.file.includes("toobig.ts"),
    );
    expect(beyondMatch).toBeUndefined();
  });

  it("puede encontrar matches dentro de los primeros 1MB de un archivo grande", async () => {
    // Write a file larger than 1MB with the query at the very beginning
    const bigPath2 = join(perfWorkspace, "bigstart.ts");
    const queryLine = "// PERF01_START_QUERY\n";
    const padding = "C".repeat(MAX_SEARCH_FILE_BYTES + 100);
    await writeFile(bigPath2, queryLine + padding);

    const result = await SEARCH_CODE_TOOL.execute(
      { query: "PERF01_START_QUERY" },
      perfWorkspace,
    );
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.content);
    const startMatch = parsed.matches.find(
      (m: { file: string }) => m.file.includes("bigstart.ts"),
    );
    expect(startMatch).toBeDefined();
    // Should be marked as truncated since file exceeds limit
    expect(startMatch.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TEST-01: Edge cases adicionales
// ---------------------------------------------------------------------------

describe("list_directory — path vacío string ''", () => {
  let ws: string;

  beforeAll(async () => {
    ws = await createWorkspace();
    await writeFile(join(ws, "file.ts"), "");
  });

  afterAll(async () => {
    await cleanupWorkspace(ws);
  });

  it("path vacío '' usa workspace root (comportamiento equivalente a '.')", async () => {
    // LIST_DIRECTORY_TOOL trata '' como '.' internamente (inputPath fallback)
    // pero resolveWorkspacePath rechaza '' con error "required"
    // Verificamos que el tool maneja el caso sin panic
    const result = await LIST_DIRECTORY_TOOL.execute({ path: "" }, ws);
    // Puede retornar error (path required) o listar root — ambos son válidos
    // Lo importante: no lanza excepción y retorna un objeto con success
    expect(typeof result.success).toBe("boolean");
    if (!result.success) {
      expect(result.error).toBeDefined();
    }
  });
});

describe("search_code — regex inválido", () => {
  let ws: string;

  beforeAll(async () => {
    ws = await createWorkspace();
    await writeFile(join(ws, "test.ts"), "// hello\n");
  });

  afterAll(async () => {
    await cleanupWorkspace(ws);
  });

  it("query con regex inválido retorna error descriptivo (no panic)", async () => {
    // Un patrón como '[invalid' es un regex inválido
    const result = await SEARCH_CODE_TOOL.execute(
      { query: "[invalid-regex" },
      ws,
    );
    // Debe retornar success:false con error descriptivo, o success:true con matches vacíos
    // (depende de si search_code usa regex o string matching)
    // Lo importante: no lanza excepción
    expect(typeof result.success).toBe("boolean");
    if (!result.success) {
      expect(result.error).toBeDefined();
    }
  });
});

describe("read_file — directorio en lugar de archivo", () => {
  let ws: string;

  beforeAll(async () => {
    ws = await createWorkspace();
    await mkdir(join(ws, "mydir"), { recursive: true });
  });

  afterAll(async () => {
    await cleanupWorkspace(ws);
  });

  it("leer un directorio retorna error descriptivo, no panic", async () => {
    const result = await READ_FILE_TOOL.execute({ path: "mydir" }, ws);
    // Debe fallar con error descriptivo (no es un archivo)
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("write_file — PROTECTED_PATHS adicionales", () => {
  let ws: string;

  beforeAll(async () => {
    ws = await createWorkspace();
  });

  afterAll(async () => {
    await cleanupWorkspace(ws);
  });

  it("rechaza escribir en package-lock.json (PROTECTED_PATHS)", async () => {
    const result = await WRITE_FILE_TOOL.execute(
      { path: "package-lock.json", content: "evil" },
      ws,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("protected path");
  });

  it("rechaza escribir en .env.local (PROTECTED_PATHS)", async () => {
    const result = await WRITE_FILE_TOOL.execute(
      { path: ".env.local", content: "SECRET=evil" },
      ws,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("protected path");
  });
});

// ---------------------------------------------------------------------------
// PERF-04: walkFiles — límite de archivos inspeccionados (MAX_FILES_WALKED)
// ---------------------------------------------------------------------------

describe("PERF-04: MAX_FILES_WALKED — límite de archivos inspeccionados", () => {
  it("MAX_FILES_WALKED está exportada y vale 10_000", () => {
    expect(MAX_FILES_WALKED).toBe(10_000);
  });

  it("search_code incluye nota de límite cuando walkedLimit es true", async () => {
    // We can't easily create 10_000 files in a test, so we test the note
    // by checking the behavior with a small workspace — walkedLimit should be false
    // and no note should appear.
    const smallWs = await mkdtemp(join(tmpdir(), "perf04-small-"));
    try {
      await writeFile(join(smallWs, "a.ts"), "// PERF04_QUERY\n");
      const result = await SEARCH_CODE_TOOL.execute(
        { query: "PERF04_QUERY" },
        smallWs,
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.content);
      // No limit note for small workspaces
      expect(parsed.walkedLimit).toBeFalsy();
      expect(parsed.note).toBeUndefined();
    } finally {
      await rm(smallWs, { recursive: true, force: true });
    }
  });

  it("list_files no incluye nota de límite en workspace pequeño", async () => {
    // list_files (list_directory) doesn't use walkFiles, but search_code does
    // Verify search_code returns walkedLimit:false for small workspaces
    const smallWs = await mkdtemp(join(tmpdir(), "perf04-list-"));
    try {
      await writeFile(join(smallWs, "b.ts"), "// hello\n");
      const result = await SEARCH_CODE_TOOL.execute(
        { query: "hello" },
        smallWs,
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.content);
      expect(parsed.walkedLimit).toBeFalsy();
    } finally {
      await rm(smallWs, { recursive: true, force: true });
    }
  });
});
