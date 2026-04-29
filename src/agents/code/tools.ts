/**
 * Code Agent tools: schemas, implementations, and path validation.
 *
 * Four filesystem tools for the code agent:
 * - read_file: Read file contents
 * - write_file: Write/create files with intermediate directories
 * - list_directory: List directory entries
 * - search_code: Recursive text search in files
 *
 * All tools enforce workspace boundary validation to prevent path traversal.
 * Symlink resolution uses realpath to prevent symlink-based path traversal.
 */

import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { resolve, relative, join, dirname, sep, extname } from "node:path";
import type { CodeToolDefinition, CodeToolResult } from "./types.ts";
import type { JsonSchema } from "../../types/llm.ts";

// ---------------------------------------------------------------------------
// Security utilities
// ---------------------------------------------------------------------------

/** Directory names to ignore during search. */
const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  "__pycache__",
]);

/** File extensions considered binary (skip during search). */
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".woff",
  ".ttf",
  ".eot",
  ".mp4",
  ".zip",
  ".gz",
  ".tar",
]);

/** Maximum number of search results. */
const MAX_SEARCH_RESULTS = 50;

/** Maximum file size to read during search (1 MB). */
const MAX_FILE_SIZE = 1_000_000;

/** Maximum file size to read per file during search_code (1 MiB). Exported for tests. */
export const MAX_SEARCH_FILE_BYTES = 1_048_576;

/** Maximum number of files walked during search/list before stopping. Exported for tests. */
export const MAX_FILES_WALKED = 10_000;

/** Paths protected from writing. */
const PROTECTED_PATHS = [
  ".git",
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.test",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
];

/** Cache para realpath del workspace — eliminates redundant syscalls. */
const workspaceRealpathCache = new Map<string, string>();

async function getRealWorkspace(workspacePath: string): Promise<string> {
  const cached = workspaceRealpathCache.get(workspacePath);
  if (cached !== undefined) return cached;
  const real = await realpath(resolve(workspacePath)).catch(
    () => resolve(workspacePath),
  );
  workspaceRealpathCache.set(workspacePath, real);
  return real;
}

/**
 * Validate that targetPath resolves to a location within workspacePath.
 *
 * Prevents path traversal attacks (e.g., `../../etc/passwd`) and
 * symlink-based traversal by resolving real paths.
 * Also rejects paths containing null bytes.
 *
 * @param targetPath - The path to validate (can be relative or absolute)
 * @param workspacePath - The workspace root (always treated as base)
 * @returns true if the resolved path is within the workspace
 */
export async function isPathWithinWorkspace(
  targetPath: string,
  workspacePath: string,
): Promise<boolean> {
  // Reject null bytes
  if (targetPath.includes("\x00") || workspacePath.includes("\x00")) {
    return false;
  }

  const resolvedTarget = await realpath(
    resolve(workspacePath, targetPath),
  ).catch(() => resolve(workspacePath, targetPath));
  const resolvedWorkspace = await getRealWorkspace(workspacePath);

  // Must be exactly the workspace or start with workspace + separator
  return (
    resolvedTarget === resolvedWorkspace ||
    resolvedTarget.startsWith(resolvedWorkspace + sep)
  );
}

/**
 * Resolve and validate a path relative to the workspace.
 *
 * Uses realpath to resolve symlinks after basic path validation,
 * preventing symlink-based path traversal attacks.
 *
 * @param inputPath - Relative or absolute path to resolve
 * @param workspacePath - Workspace root directory
 * @returns Result type: { ok: true, value: string } or { ok: false, error: string }
 */
export async function resolveWorkspacePath(
  inputPath: string,
  workspacePath: string,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  // Check vacío PRIMERO
  if (inputPath.length === 0) {
    return { ok: false, error: "Path argument is required" };
  }

  // Reject null bytes
  if (inputPath.includes("\x00")) {
    return {
      ok: false,
      error: "Path contains null bytes: rejected for security",
    };
  }

  const resolvedTarget = resolve(workspacePath, inputPath);
  const resolvedWorkspace = resolve(workspacePath);

  if (
    resolvedTarget !== resolvedWorkspace &&
    !resolvedTarget.startsWith(resolvedWorkspace + sep)
  ) {
    return {
      ok: false,
      error: "Path resolves outside workspace. Path traversal is not allowed.",
    };
  }

  // Resolve symlinks after basic validation
  const realTarget = await realpath(resolvedTarget).catch(
    () => resolvedTarget,
  );
  const realWorkspace = await getRealWorkspace(workspacePath);

  if (
    realTarget !== realWorkspace &&
    !realTarget.startsWith(realWorkspace + sep)
  ) {
    return {
      ok: false,
      error:
        "Path resolves outside workspace via symlink. Not allowed.",
    };
  }

  return { ok: true, value: realTarget };
}

// ---------------------------------------------------------------------------
// Helper: create error result
// ---------------------------------------------------------------------------

function errorResult(error: string): CodeToolResult {
  return { content: "", error, success: false };
}

// ---------------------------------------------------------------------------
// Tool: read_file
// ---------------------------------------------------------------------------

export const READ_FILE_TOOL: CodeToolDefinition = {
  name: "read_file",
  description:
    "Read the contents of a file at the given path. Path is relative to the workspace root.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file, relative to workspace root",
      },
    },
    required: ["path"],
  },
  async execute(
    args: Record<string, unknown>,
    workspacePath: string,
  ): Promise<CodeToolResult> {
    const path = args["path"];
    if (typeof path !== "string" || path.length === 0) {
      return errorResult(
        "Argument 'path' is required and must be a non-empty string.",
      );
    }

    const resolved = await resolveWorkspacePath(path, workspacePath);
    if (!resolved.ok) {
      return errorResult(resolved.error);
    }

    try {
      const fileStat = await stat(resolved.value);
      if (fileStat.size > MAX_FILE_SIZE) {
        return errorResult("File too large to read (max 1MB).");
      }
    } catch {
      return errorResult("Failed to read file: the file could not be accessed");
    }

    try {
      const content = await readFile(resolved.value, "utf-8");
      return { content, success: true };
    } catch {
      return errorResult("Failed to read file: the file could not be accessed");
    }
  },
};

// ---------------------------------------------------------------------------
// Tool: write_file
// ---------------------------------------------------------------------------

export const WRITE_FILE_TOOL: CodeToolDefinition = {
  name: "write_file",
  description:
    "Write content to a file at the given path. Creates parent directories if needed. Overwrites existing files.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file, relative to workspace root",
      },
      content: {
        type: "string",
        description: "Content to write to the file",
      },
    },
    required: ["path", "content"],
  },
  async execute(
    args: Record<string, unknown>,
    workspacePath: string,
  ): Promise<CodeToolResult> {
    const path = args["path"];
    const content = args["content"];

    if (typeof path !== "string" || path.length === 0) {
      return errorResult(
        "Argument 'path' is required and must be a non-empty string.",
      );
    }

    if (typeof content !== "string") {
      return errorResult(
        "Argument 'content' is required and must be a string.",
      );
    }

    const resolved = await resolveWorkspacePath(path, workspacePath);
    if (!resolved.ok) {
      return errorResult(resolved.error);
    }

    const resolvedWorkspace = resolve(workspacePath);
    const relativeToWorkspace = relative(resolvedWorkspace, resolved.value);
    for (const protected_path of PROTECTED_PATHS) {
      if (
        relativeToWorkspace.startsWith(protected_path + sep) ||
        relativeToWorkspace === protected_path
      ) {
        return errorResult(
          `Cannot write to protected path: "${path}". This path is reserved.`,
        );
      }
    }

    try {
      // Create intermediate directories if needed
      await mkdir(dirname(resolved.value), { recursive: true });
      await writeFile(resolved.value, content, "utf-8");
      return {
        content: `File written successfully: ${path}`,
        success: true,
      };
    } catch {
      return errorResult(
        "Failed to write file: the file could not be written",
      );
    }
  },
};

// ---------------------------------------------------------------------------
// Tool: list_directory
// ---------------------------------------------------------------------------

export const LIST_DIRECTORY_TOOL: CodeToolDefinition = {
  name: "list_directory",
  description:
    "List files and directories at the given path. Returns array of {name, type}.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Path to the directory, relative to workspace root. Defaults to workspace root.",
      },
    },
    required: [],
  },
  async execute(
    args: Record<string, unknown>,
    workspacePath: string,
  ): Promise<CodeToolResult> {
    const inputPath = typeof args["path"] === "string" ? args["path"] : ".";

    const resolved = await resolveWorkspacePath(inputPath, workspacePath);
    if (!resolved.ok) {
      return errorResult(resolved.error);
    }

    try {
      const entries = await readdir(resolved.value, { withFileTypes: true });
      const result = entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : ("file" as const),
      }));

      return { content: JSON.stringify(result), success: true };
    } catch {
      return errorResult(
        "Failed to list directory: the directory could not be accessed",
      );
    }
  },
};

// ---------------------------------------------------------------------------
// Tool: search_code
// ---------------------------------------------------------------------------

/**
 * Recursively walk a directory, yielding file paths.
 * Skips ignored directories and binary files.
 * Enforces a maximum depth to prevent infinite recursion.
 * Enforces MAX_FILES_WALKED to prevent excessive scanning in large workspaces.
 */
async function* walkFiles(
  dir: string,
  ignoredDirs: Set<string>,
  binaryExts: Set<string>,
  maxDepth: number = 20,
  currentDepth: number = 0,
  counter: { count: number; limit: boolean } = { count: 0, limit: false },
): AsyncGenerator<string> {
  if (currentDepth >= maxDepth) return;
  if (counter.limit) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (counter.limit) return;
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        yield* walkFiles(fullPath, ignoredDirs, binaryExts, maxDepth, currentDepth + 1, counter);
      }
    } else if (entry.isFile()) {
      counter.count++;
      if (counter.count > MAX_FILES_WALKED) {
        counter.limit = true;
        return;
      }
      const ext = extname(entry.name).toLowerCase();
      if (!binaryExts.has(ext)) {
        yield fullPath;
      }
    }
  }
}

export const SEARCH_CODE_TOOL: CodeToolDefinition = {
  name: "search_code",
  description:
    "Search for a text string in files within the workspace. Returns matching file paths with line numbers and content.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Text to search for",
      },
      path: {
        type: "string",
        description:
          "Directory to search in, relative to workspace root. Defaults to workspace root.",
      },
    },
    required: ["query"],
  },
  async execute(
    args: Record<string, unknown>,
    workspacePath: string,
  ): Promise<CodeToolResult> {
    const query = args["query"];
    if (typeof query !== "string" || query.length === 0) {
      return errorResult(
        "Argument 'query' is required and must be a non-empty string.",
      );
    }

    const inputPath = typeof args["path"] === "string" ? args["path"] : ".";

    const resolved = await resolveWorkspacePath(inputPath, workspacePath);
    if (!resolved.ok) {
      return errorResult(resolved.error);
    }

    // Verify the path is a directory
    try {
      const s = await stat(resolved.value);
      if (!s.isDirectory()) {
        return errorResult(`Path "${inputPath}" is not a directory.`);
      }
    } catch {
      return errorResult(
        "Failed to access path: the path could not be accessed",
      );
    }

    const matches: Array<{ file: string; line: number; content: string; truncated?: true }> = [];
    const resolvedWorkspace = resolve(workspacePath);
    const counter = { count: 0, limit: false };

    try {
      for await (const filePath of walkFiles(
        resolved.value,
        IGNORED_DIRECTORIES,
        BINARY_EXTENSIONS,
        20,
        0,
        counter,
      )) {
        if (matches.length >= MAX_SEARCH_RESULTS) break;

        // PERF-01: Read at most MAX_SEARCH_FILE_BYTES per file using slice
        try {
          const file = Bun.file(filePath);
          const fileSize = file.size;
          const isTruncated = fileSize > MAX_SEARCH_FILE_BYTES;
          const content = await file.slice(0, MAX_SEARCH_FILE_BYTES).text();

          // Iterate by indexOf to avoid split("\n") memory duplication
          let pos = 0;
          let lineNum = 0;
          while (pos < content.length) {
            lineNum++;
            const nextNewline = content.indexOf("\n", pos);
            const end = nextNewline === -1 ? content.length : nextNewline;
            const line = content.substring(pos, end);
            if (line.includes(query)) {
              const relativePath = relative(resolvedWorkspace, filePath);
              const match: { file: string; line: number; content: string; truncated?: true } = {
                file: relativePath,
                line: lineNum,
                content: line,
              };
              if (isTruncated) match.truncated = true;
              matches.push(match);
              if (matches.length >= MAX_SEARCH_RESULTS) break;
            }
            pos = end + 1;
          }
        } catch (err) {
          const relativePath = relative(resolvedWorkspace, filePath);
          console.error(`[code-agent] Skipping file ${relativePath}: read error`);
          continue;
        }
      }
    } catch (err) {
      console.error(`[code-agent] Search failed:`, err);
      return errorResult("Search failed: unable to complete the search operation");
    }

    // PERF-04: Include walkedLimit flag and note if limit was reached
    const result: { matches: typeof matches; walkedLimit?: true; note?: string } = { matches };
    if (counter.limit) {
      result.walkedLimit = true;
      result.note = `[Nota: búsqueda limitada a los primeros ${MAX_FILES_WALKED.toLocaleString()} archivos del workspace]`;
    }

    return {
      content: JSON.stringify(result),
      success: true,
    };
  },
};

// ---------------------------------------------------------------------------
// Aggregated exports
// ---------------------------------------------------------------------------

/** Todas las herramientas del code agent. */
export const CODE_AGENT_TOOLS: readonly CodeToolDefinition[] = [
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  LIST_DIRECTORY_TOOL,
  SEARCH_CODE_TOOL,
];

/** Map for O(1) tool lookup by name. */
const TOOL_MAP = new Map(CODE_AGENT_TOOLS.map((t) => [t.name, t]));

/** Cached schemas (lazy singleton). */
let cachedSchemas:
  | Array<{ name: string; description: string; parameters: JsonSchema }>
  | undefined;

/** Obtener los schemas de tools en formato LLMChatOptions.tools. */
export function getToolSchemas(): Array<{
  name: string;
  description: string;
  parameters: JsonSchema;
}> {
  if (!cachedSchemas) {
    cachedSchemas = CODE_AGENT_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }
  return cachedSchemas;
}

/** Ejecutar una herramienta por nombre. */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  workspacePath: string,
): Promise<CodeToolResult> {
  const tool = TOOL_MAP.get(toolName);
  if (!tool) {
    return errorResult(`Unknown tool: "${toolName}"`);
  }
  return tool.execute(args, workspacePath);
}
