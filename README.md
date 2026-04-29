# personal-asistent

> Headless ACP programming agent that communicates with editors (Zed, JetBrains) via stdio JSON-RPC.

[![CI](https://github.com/personal-asistent/personal-asistent/actions/workflows/ci.yml/badge.svg)](https://github.com/personal-asistent/personal-asistent/actions/workflows/ci.yml)

---

## ⚠️ Requirements

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Bun** | ≥ 1.3.5 | **REQUIRED** — uses `bun:sqlite` for persistence (built-in Bun module, not available in Node.js) |
| Node.js | ≥ 20.0.0 | Required for `npm install -g` / `npx` invocation |

> **Important**: Even though the binary can be installed via npm/npx, **Bun must be installed on the host machine** because the agent uses `bun:sqlite` at runtime. The shebang `#!/usr/bin/env node` is for npm compatibility, but the process will fail without Bun if sqlite persistence is invoked.

---

## Installation

### Global install via npm

```bash
npm install -g personal-asistent
```

### Run without installing (npx)

```bash
npx personal-asistent
```

### Global install via Bun (recommended)

```bash
bun add -g personal-asistent
```

---

## Configuration

The agent reads configuration from `~/.config/personal-asistent/config.toml`. API keys are **never** stored in files — use environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes (if using Claude) | Anthropic API key |
| `OPENAI_API_KEY` | Yes (if using GPT) | OpenAI API key |
| `OLLAMA_HOST` | No | Ollama server URL (default: `http://localhost:11434`) |

### Example environment setup

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
# Optional: local models via Ollama
export OLLAMA_HOST="http://localhost:11434"
```

### Config file (optional)

```toml
# ~/.config/personal-asistent/config.toml

[llm]
default_provider = "anthropic"   # "anthropic" | "openai" | "ollama"
default_model    = "claude-sonnet-4-5"

[llm.anthropic]
model = "claude-sonnet-4-5"

[llm.openai]
model = "gpt-4o"

[llm.ollama]
host  = "http://localhost:11434"
model = "llama3"
```

---

## Usage with Editors

### Zed

Add to your Zed `settings.json`:

```json
{
  "assistant": {
    "version": "2",
    "default_model": {
      "provider": "custom",
      "model": "personal-asistent"
    }
  },
  "context_servers": {
    "personal-asistent": {
      "command": {
        "path": "personal-asistent",
        "args": []
      }
    }
  }
}
```

### JetBrains (AI Assistant plugin)

Configure the ACP server in **Settings → Tools → AI Assistant → Custom Servers**:

- **Command**: `personal-asistent`
- **Arguments**: *(leave empty)*
- **Transport**: `stdio`

---

## Development

```bash
# Clone and install
git clone https://github.com/personal-asistent/personal-asistent.git
cd personal-asistent
bun install

# Run in development mode (hot reload)
bun --hot run src/index.ts

# Run tests
bun test

# Build development bundle (sourcemaps, no minification — readable stack traces)
bun run build

# Build production bundle (minified ~33% smaller, for npm distribution)
bun run build:prod

# Run compiled bundle
bun dist/index.js
```

---

## Architecture

The agent is structured as a set of specialized sub-agents orchestrated via JSON-RPC over stdio:

```
src/
  core/           # Utilities, logging, errors
  transport/      # stdio NDJSON layer (JSON-RPC over stdin/stdout)
  protocol/       # ACP server: initialize, session/*, permissions
  llm/            # Provider layer: Anthropic, OpenAI, Ollama, llama.cpp
  orchestrator/   # Intent router + context injection
  agents/
    code/         # File read/write/grep/AST
    os/           # Shell with blacklist and permissions
    docs/         # Web documentation search + fetch
    git/          # Commits, branches, PRs via git/gh CLI
  persistence/    # SQLite (bun:sqlite): sessions, turns, messages, tool_calls
  config/         # ~/.config/personal-asistent/config.toml loader (Zod)
  types/          # Domain types (JSON-RPC, ACP, LLM, Agent, DB)
```

For advanced configuration and architecture details, see [`docs/`](./docs/).

---

## License

MIT
