# AGENTS.md — personal-asistent

> Contexto para sesiones OpenCode. Lee esto antes de tocar código.

## Stack y runtime

- **Runtime**: Bun v1.3.5+ (exclusivo; no garantizado con Node.js)
- **Lenguaje**: TypeScript estricto, ESM puro (`"type": "module"`)
- **Build**: `tsup` → bundle ESM único en `dist/`, target `node20`
- **Tests**: `bun:test` (runtime Bun, sintaxis compatible con Jest)
- **DB**: SQLite vía `bun:sqlite` (built-in en Bun, sincrónico, sin dependencias npm)

## Comandos esenciales

```bash
# Instalar dependencias
bun install

# Desarrollo (hot reload)
bun --hot run src/index.ts

# Build para producción
bun run build        # tsup bundle → dist/index.js

# Tests
bun test             # todos los tests
bun test <patrón>    # test filtrado (ej: bun test transport)

# Ejecutar binario compilado
bun dist/index.js    # o: ./dist/index.js con shebang (requiere Bun)
```

## Arquitectura del proyecto

Agente ACP headless que se comunica con editores (Zed, JetBrains) vía stdio JSON-RPC. Orquesta 4 sub-agentes especializados más el orquestador y agentes de apoyo (arquitecto, code-smith, y 3 auditores paralelos).

```
src/
  core/           # Utilidades, logging, errores
  transport/      # Capa stdio NDJSON (JSON-RPC sobre stdin/stdout)
  protocol/       # Servidor ACP: initialize, session/*, permisos
  llm/            # Capa de proveedores: Anthropic, OpenAI, Ollama, llama.cpp
  orchestrator/   # Router de intención + inyección de contexto
  agents/         # Sub-agentes especializados
    code/         # Lectura/escritura de archivos, grep, AST
    os/           # Shell con lista negra y permisos
    docs/         # Búsqueda web de documentación técnica + fetch
    git/          # Commits, ramas, PRs vía git/gh CLI
  persistence/    # SQLite: sessions, turns, messages, tool_calls, summaries
  config/         # Carga de ~/.config/personal-asistent/config.toml (Zod)
  types/          # Tipos del dominio (JSON-RPC, ACP, LLM, Agent, DB)
```

### 4 sub-agentes de dominio (v1)

Estos son los agentes que operan sobre el workspace del usuario:

| Agente | Routing key | Herramientas principales |
|--------|-------------|--------------------------|
| Código | `code` | read/write/list/search archivos, generar tests |
| OS/Shell | `os` | Ejecutar comandos con permisos explícitos, runners de test |
| Documentación web | `docs` | Búsqueda (Brave/Tavily) + fetch HTML limpio |
| Git/VCS | `git` | git status/diff/log/commit/branch/push, PRs vía gh/glab |

### Agentes del workflow de desarrollo

Además de los 4 sub-agentes de dominio, el sistema de orquestación define estos agentes especializados para el flujo de desarrollo:

| Agente | Rol | Permisos de edición |
|--------|-----|---------------------|
| **orchestrator** | Coordina todo el workflow, único que habla con el usuario | `allow` |
| **architecto** | Diseña sistemas, divide en tareas atómicas en `docs/tasks/` | `allow` (solo docs) |
| **code-smith** | Implementa tareas con TDD estricto | `allow` |
| **test-mancer** | Verifica edge cases y cobertura de tests | `ask` |
| **type-sheriff** | Revisa calidad TypeScript, tipos y mejores prácticas | `deny` (solo lectura) |
| **security-guardian** | Audita vulnerabilidades, secrets e inyecciones | `ask` (patches críticos) |
| **perf-wizard** | Optimiza rendimiento sin romper funcionalidad | `ask` |

## Reglas críticas del proyecto

1. **stdout es sagrado**: Solo JSON-RPC. Cualquier `console.log` debe ir a `stderr` o rompe el protocolo ACP. El transporte stdio redirige `console.log` globalmente a `process.stderr`.

2. **ESM puro**: Todos los imports internos post-build usan extensión `.js` (tsup resuelve automáticamente desde `.ts`). Nunca uses `require()`.

3. **Interfaces primero**: La Tarea 02 define todos los contratos (`LLMProvider`, `Agent`, tipos ACP). Nunca implementes antes de tener la interfaz tipada.

4. **Configuración**: Variables de entorno > `config.toml` > defaults. API keys nunca en archivos, solo en env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_HOST`).

5. **Permisos destructivos**: Toda ejecución shell pasa por `session/request_permission`. Lista negra por defecto: `rm -rf`, `dd`, `git reset --hard`, `git push --force`, `git clean -fd`.

6. **Sliding window**: Contexto limitado a últimos 10 mensajes. Al 70% de tokens del modelo, mensajes antiguos se resumen vía LLM barato y se persisten en SQLite.

7. **Zero telemetría**: No se envía ningún dato de uso, errores ni métricas a servidores externos. Ni siquiera opcional.

## Flujo de trabajo con subagentes

Este repo usa un sistema de orquestación con agentes especializados definidos en `.opencode/opencode.json`:

- **orchestrator** (tú): Único que habla con el usuario. Coordina el workflow.
- **architecto**: Diseña sistemas, crea tareas en `docs/tasks/`. No toca código de producción.
- **code-smith**: Implementa tareas con TDD estricto. Lee `docs/tasks/##-nombre.md` y entrega.
- **test-mancer**: Verifica edge cases y cobertura. No edita sin permiso.
- **type-sheriff**: Revisa calidad TypeScript. Solo lectura + reporte.
- **security-guardian**: Audita seguridad y vulnerabilidades. Opera en paralelo con test-mancer y type-sheriff. Edita solo con permiso explícito.
- **perf-wizard**: Optimiza rendimiento. Pregunta antes de editar.

### Flujo de verificación post-implementación (Paso 5)

Tras entregar `code-smith`, el orchestrator lanza cuatro auditorías en paralelo:

```
Paso 5: Verificación paralela (4 auditorías)
├── test-mancer        → edge cases, cobertura
├── type-sheriff       → calidad TypeScript
├── perf-wizard        → optimización de rendimiento
└── security-guardian  → vulnerabilidades, secrets, inyecciones
```

**Reglas de decisión:**
- Si `test-mancer` encuentra bugs críticos → rechazar, volver a `code-smith`
- Si `type-sheriff` reporta errores críticos de tipos → rechazar, volver a `code-smith`
- Si `security-guardian` detecta vulnerabilidad **CRÍTICA** o **ALTA** → rechazar, volver a `code-smith` con detalle del hallazgo
- Si `security-guardian` solo encuentra riesgo **MEDIO** o **BAJO** → aprobar con advertencias; el orchestrator decide si aplicar fix directo o delegar a `code-smith`
- Si `perf-wizard` reporta problemas de rendimiento críticos → documentar; el orchestrator decide si bloquear o aprobar con notas
- Si los cuatro aprueban → marcar tarea completada

### Handoff obligatorio

Todo subagente debe completar un **HANDOFF** al terminar, usando el formato de `docs/handoff-template.md`. El orchestrator parsea el handoff y decide el siguiente paso.

### Log del orchestrator

Toda decisión, delegación y archivo modificado se registra en `docs/orchestrator-log.md`. Actualizar después de cada acción.

## Convenciones de código

- **Clases**: PascalCase (`StdioTransport`, `Orchestrator`)
- **Archivos**: kebab-case (`stdio-transport.ts`, `git-agent.ts`)
- **Interfaces**: Prefijo `I` opcional, preferir nombres descriptivos (`LLMProvider`, `AgentContext`)
- **IDs de sesión**: Branded types (`type SessionId = string & { __brand: 'SessionId' }`)
- **Enums**: `const enum` o `as const` objects para inmutabilidad
- **Error handling**: Usar `Result<T, E>` pattern o throw con tipos específicos; nunca silenciar errores de JSON-RPC

## Referencias obligatorias

- `docs/PRD-asistente-acp.md` — Requisitos y decisiones arquitectónicas (v0.3)
- `docs/tasks/##-nombre.md` — Tareas atómicas (19 tareas, Fase 0→2)
- `docs/handoff-template.md` — Formato de entrega de subagentes
- `docs/orchestrator-log.md` — Registro de decisiones y progreso
- `.opencode/opencode.json` — Configuración de agentes y permisos

## Riesgos conocidos

- `bun:sqlite` es built-in en Bun. No funciona con Node.js puro. El paquete npm requiere Bun como runtime.
- SDK ACP (`@zed-industries/agent-client-protocol`) puede cambiar de spec. Pinear versión exacta.
- Modelos locales (Ollama/llama.cpp) fallan en cadenas de herramientas largas. Documentar limitaciones.

## Limitaciones de modelos locales (Ollama/llama.cpp)

- OS Agent y Git Agent requieren un modelo con soporte de tool calling.
  Ollama: usar llama3.1, qwen2.5, mistral-nemo o similar.
- Modelos <7B fallan en cadenas de >3 herramientas (contexto insuficiente).
- llama.cpp (provider local) no implementa tool calling en v1.
  Para usar agentes con herramientas, usar Ollama o un provider cloud.

## Tests

- Framework: `bun:test` (describe, it, expect, mock)
- Cobertura objetivo: >70% en orquestador
- Mocks: LLMProvider con respuestas fijas, SQLite en memoria (`:memory:`)
- Tests de integración: Simular flujo completo stdio → JSON-RPC → ACP

## Build y distribución

- Bundle con `tsup` a `dist/index.js` (ESM, self-contained)
- Campo `bin` en `package.json` apunta a `dist/index.js`
- Sin native modules externas: `bun:sqlite` es built-in en Bun
- CI: GitHub Actions — tests en PR, publish a npm en tags SemVer
