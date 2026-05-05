# Personal Asistent — VS Code Extension

Chat Participant `@asistent` para VS Code que conecta con los agentes especializados de personal-asistent.

## Agentes disponibles

| Comando | Agente | Función |
|---------|--------|---------|
| *(ninguno)* | Orquestador | Detecta la intención y delega al agente correcto |
| `/code` | Code Agent | Lee/escribe archivos, busca código, genera tests |
| `/os` | OS Agent | Ejecuta comandos shell con permisos explícitos |
| `/docs` | Docs Agent | Busca documentación técnica en la web |
| `/git` | Git Agent | Gestiona commits, ramas y pull requests |

## Requisitos

- VS Code 1.95+
- [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat) instalado y activo
- [Bun](https://bun.sh) instalado (`bun --version` ≥ 1.3.5)
- Al menos una API Key configurada (ver configuración)

## Configuración

Abre *Configuración* (`Ctrl+,`) y busca **Personal Asistent**:

| Ajuste | Descripción | Default |
|--------|-------------|---------|
| `personalAsistent.bunExecutable` | Ruta al ejecutable Bun | `bun` |
| `personalAsistent.serverPath` | Directorio del proyecto personal-asistent | Auto-detectado |
| `personalAsistent.anthropicApiKey` | Anthropic API Key | — |
| `personalAsistent.openaiApiKey` | OpenAI API Key | — |
| `personalAsistent.ollamaHost` | URL de Ollama local | — |
| `personalAsistent.lmStudioHost` | URL de LM Studio local | — |

> **Recomendado**: usa variables de entorno (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) en lugar de guardar las claves en la configuración de VS Code.

## Uso

1. Abre el chat de Copilot (`Ctrl+Alt+I`)
2. Escribe `@asistent` seguido de tu petición:

```
@asistent explica la función authenticate en src/auth.ts
@asistent /code crea tests para el módulo de persistencia
@asistent /git haz un commit con los cambios actuales
@asistent /docs cómo funciona la sliding window en LLMs
```

## Desarrollo local

```bash
# Instalar dependencias
cd vscode-extension
npm install

# Compilar
npm run build

# Ver cambios en tiempo real
npm run watch
```

Para depurar la extensión, abre este directorio en VS Code y presiona `F5`.

## Comandos

- **Personal Asistent: Show Log** — Muestra el canal de salida del servidor
- **Personal Asistent: Restart** — Reinicia el servidor en el próximo mensaje

## Arquitectura

```
VS Code Chat
    │  @asistent <mensaje>
    ▼
participant.ts          ← Chat Participant handler
    │  session/prompt
    ▼
rpc-client.ts           ← Cliente JSON-RPC 2.0 sobre stdio
    │  stdin/stdout
    ▼
server-manager.ts       ← Gestiona proceso hijo (bun run src/index.ts)
    │
    ▼
personal-asistent       ← Servidor ACP con 4 sub-agentes
```
