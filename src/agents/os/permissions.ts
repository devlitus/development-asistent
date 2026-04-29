/**
 * OS Agent permissions: command risk classification.
 *
 * Classifies shell commands into three risk levels:
 * - safe: Normal commands with no destructive potential
 * - sensitive: Commands that require elevated privileges or can cause data loss
 * - destructive: Commands that can cause irreversible system damage
 *
 * Known limitations:
 * - Pattern matching is conservative: display commands (echo, printf, cat) are
 *   detected first to avoid false positives like `echo rm -rf /`.
 * - Shell metacharacters ($(), backticks, heredocs) are not fully parsed;
 *   the risk assessment operates on the raw command string.
 * - Patterns are not a substitute for a full shell parser.
 */

export type CommandRisk = "safe" | "sensitive" | "destructive";

export interface RiskAssessment {
  risk: CommandRisk;
  reason: string;
  matchedPattern?: string;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

interface RiskPattern {
  pattern: RegExp;
  risk: CommandRisk;
  reason: string;
}

/**
 * Display-only commands whose arguments should not be evaluated for risk.
 *
 * If the command consists ONLY of a display command (no semicolons, pipes,
 * or command chaining), dangerous-looking arguments are treated as string
 * literals, not executable commands.
 *
 * Examples:
 *   "echo rm -rf /"        → safe  (display command only)
 *   "echo x; sudo rm foo"  → NOT a display command (has semicolon)
 *   "printf rm -rf /"      → safe
 *
 * Known limitation: `echo $(rm -rf /)` would still be dangerous in a real
 * shell, but we accept this as a conservative v1 trade-off.
 */
const DISPLAY_COMMAND_RE =
  /^\s*(echo|printf|print|cat|less|more|head|tail|write)\b/i;

/**
 * Characters that indicate command chaining — disqualify display-command fast path.
 * Exported so tools.ts can use it for metachar detection (NEW-A1).
 * Includes newline (\n) as a command separator for defense-in-depth (SEC-14).
 */
export const COMMAND_CHAIN_RE = /[;|&`$()\n]/;

/**
 * Ordered list of risk patterns.
 * Evaluated top-to-bottom; first match wins.
 * More specific patterns should come before general ones.
 */
const RISK_PATTERNS: readonly RiskPattern[] = [
  // ── Destructive: Fork bomb ──────────────────────────────────────────────
  {
    pattern: /:\(\)\s*\{/,
    risk: "destructive",
    reason: "Fork bomb pattern detected — can crash the system",
  },

  // ── Destructive: rm with recursive + force (combined flags, case-insensitive) ─
  {
    pattern: /\brm\s+.*-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+[/\\]/i,
    risk: "destructive",
    reason: "Recursive forced removal of root or broad path",
  },
  {
    pattern: /\brm\s+.*-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+[/\\]/i,
    risk: "destructive",
    reason: "Recursive forced removal of root or broad path",
  },
  {
    pattern: /\brm\s+.*-rf\b/i,
    risk: "destructive",
    reason: "Recursive forced removal — can cause irreversible data loss",
  },
  {
    pattern: /\brm\s+.*-fr\b/i,
    risk: "destructive",
    reason: "Recursive forced removal — can cause irreversible data loss",
  },

  // ── Destructive: rm with separate -r and -f flags ───────────────────────
  {
    pattern: /\brm\s+.*-r\s+-f\b/i,
    risk: "destructive",
    reason: "Recursive forced removal (separate flags) — irreversible data loss",
  },
  {
    pattern: /\brm\s+.*-f\s+-r\b/i,
    risk: "destructive",
    reason: "Recursive forced removal (separate flags) — irreversible data loss",
  },

  // ── Destructive: rm with long flags ─────────────────────────────────────
  {
    pattern: /\brm\b.*--recursive.*--force/i,
    risk: "destructive",
    reason: "rm --recursive --force — irreversible data loss",
  },
  {
    pattern: /\brm\b.*--force.*--recursive/i,
    risk: "destructive",
    reason: "rm --force --recursive — irreversible data loss",
  },

  // ── Destructive: dd (disk destroyer) ────────────────────────────────────
  {
    pattern: /\bdd\s+.*\bif=/,
    risk: "destructive",
    reason: "dd with input file — can overwrite disk devices",
  },

  // ── Destructive: disk formatting ────────────────────────────────────────
  {
    pattern: /\bmkfs\b/,
    risk: "destructive",
    reason: "mkfs formats filesystems — irreversible data loss",
  },
  {
    pattern: /\bformat\s+[A-Za-z]:/i,
    risk: "destructive",
    reason: "Windows format command — irreversible disk formatting",
  },

  // ── Destructive: Windows del with /s /q flags ───────────────────────────
  {
    pattern: /\bdel\s+.*\/[sS].*\/[qQ]/,
    risk: "destructive",
    reason: "Windows del with recursive and quiet flags — mass file deletion",
  },
  {
    pattern: /\bdel\s+.*\/[qQ].*\/[sS]/,
    risk: "destructive",
    reason: "Windows del with recursive and quiet flags — mass file deletion",
  },

  // ── Destructive: Windows rd/rmdir /s ────────────────────────────────────
  {
    pattern: /\brd\s+\/[sS]\s+\/[qQ]/i,
    risk: "destructive",
    reason: "Windows rd /s /q — recursive directory removal",
  },
  {
    pattern: /\brd\s+\/[qQ]\s+\/[sS]/i,
    risk: "destructive",
    reason: "Windows rd /s /q — recursive directory removal",
  },
  {
    pattern: /\brmdir\s+.*\/[sS]\b/i,
    risk: "destructive",
    reason: "Windows rmdir /s — recursive directory removal",
  },

  // ── Sensitive: git destructive operations ───────────────────────────────
  {
    pattern: /\bgit\s+reset\s+--hard\b/,
    risk: "sensitive",
    reason: "git reset --hard discards uncommitted changes",
  },
  {
    pattern: /\bgit\s+push\s+.*(-f|--force)\b/,
    risk: "sensitive",
    reason: "git push --force can overwrite remote history",
  },
  {
    pattern: /\bgit\s+clean\s+.*-[a-zA-Z]*f/,
    risk: "sensitive",
    reason: "git clean -f removes untracked files",
  },

  // ── Sensitive: privilege escalation (anywhere in command) ───────────────
  {
    pattern: /\bsudo\b/,
    risk: "sensitive",
    reason: "sudo executes commands with elevated privileges",
  },
  {
    pattern: /\bsu\b/,
    risk: "sensitive",
    reason: "su switches to another user account",
  },

  // ── Sensitive: permission changes ───────────────────────────────────────
  {
    pattern: /\bchmod\s+0?777\b/,
    risk: "sensitive",
    reason: "chmod 777 grants world-writable permissions",
  },
  {
    pattern: /\bchown\b/,
    risk: "sensitive",
    reason: "chown changes file ownership",
  },

  // ── Sensitive: pipe to shell or interpreter (remote code execution) ─────
  {
    pattern:
      /\|\s*(bash|sh|zsh|fish|pwsh|powershell|ksh|dash|csh|tcsh|ash|node|python[23]?|perl|ruby|bun)\b/i,
    risk: "sensitive",
    reason: "Piping to shell or interpreter can execute arbitrary remote code",
  },

  // ── Sensitive: global package installs ──────────────────────────────────
  {
    pattern: /\bnpm\s+(install|i)\s+.*-g\b/,
    risk: "sensitive",
    reason: "npm install -g installs packages globally",
  },
  {
    pattern: /\bnpm\s+(install|i)\s+.*--global\b/,
    risk: "sensitive",
    reason: "npm install --global installs packages globally",
  },
  {
    pattern: /\bpip[23]?\s+install\s+.*--user\b/,
    risk: "sensitive",
    reason: "pip install --user installs packages for the current user",
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assess the risk level of a shell command string.
 *
 * Checks the command against a list of known dangerous patterns.
 * Returns the first matching risk level (highest risk wins).
 * Unknown/unmatched commands default to "safe".
 *
 * Special case: commands that start with display-only programs (echo, printf,
 * cat, etc.) are classified as "safe" to avoid false positives like
 * `echo rm -rf /`. This is a conservative v1 heuristic.
 *
 * @param command - The full command string to assess
 * @returns RiskAssessment with risk level, reason, and matched pattern
 */
export function assessCommandRisk(command: string): RiskAssessment {
  // Fast path: display-only commands with no chaining cannot execute their arguments
  if (DISPLAY_COMMAND_RE.test(command) && !COMMAND_CHAIN_RE.test(command)) {
    return {
      risk: "safe",
      reason: "Display-only command — arguments are treated as string literals",
    };
  }

  for (const { pattern, risk, reason } of RISK_PATTERNS) {
    if (pattern.test(command)) {
      return {
        risk,
        reason,
        matchedPattern: pattern.source,
      };
    }
  }

  return {
    risk: "safe",
    reason: "No dangerous patterns detected",
  };
}
