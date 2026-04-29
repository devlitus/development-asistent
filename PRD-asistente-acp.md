# PRD — Asistente de programación distribuido por npm (Agente ACP)

**Versión:** 0.3 (borrador)
**Fecha:** 26 de abril de 2026
**Autor:** Carles
**Estado:** Propuesta con decisiones técnicas resueltas

**Cambios desde v0.2:**
- Sub-agente de datos sustituido por sub-agente de Git/VCS (más alineado con el público dev).
- Sub-agente "web" renombrado y reenfocado a búsqueda de documentación técnica.

**Cambios desde v0.1:**
- Soporte de modelos cloud y locales desde v1.
- Estrategia de gestión de contexto definida (SQLite + sliding window con resumen).
- Política de telemetría: cero, ni opcional.
- VSCode descartado de v1 y v2.

---

## 1. Resumen ejecutivo

Construir un **agente de programación headless** distribuido como paquete npm. El agente implementa el [Agent Client Protocol (ACP)](https://agentclientprotocol.com/), por lo que cualquier editor compatible (Zed, plugin de JetBrains, plugins comunitarios de Neovim/VSCode) puede arrancarlo como subproceso y conversar con él sobre stdio.

Internamente, el agente orquesta cuatro sub-agentes especializados (código, OS/shell, documentación web, Git/VCS) y se apoya en MCP servers para herramientas concretas.

No tiene UI propia: la pone el editor.

---

## 2. Problema y oportunidad

Los desarrolladores que quieren un asistente potente hoy tienen que elegir entre:

- Asistentes acoplados a un único editor (Cursor, Copilot Chat).
- CLIs aislados que no se integran bien con el flujo del editor (algunos agentes de terminal).
- Agentes propietarios que no permiten cambiar de editor sin perder estado.

ACP soluciona el acoplamiento editor-agente, pero hoy hay pocos agentes ACP públicos. Hay hueco para uno con sub-agentes especializados, instalable con un `npm i -g`, y agnóstico al modelo LLM.

---

## 3. Usuarios y caso de uso

**Usuario principal:** desarrollador que ya usa un editor compatible con ACP o está dispuesto a probar uno.

**Caso de uso típico:**

1. Instala el paquete: `npm install -g tu-asistente`.
2. Configura su editor para apuntar al binario del agente.
3. Abre un proyecto, lanza una sesión, y pide cosas como:
   - "Refactoriza este módulo a TypeScript estricto."
   - "Busca en la documentación oficial de Postgres cómo hacer X y aplícalo."
   - "Corre los tests, analiza los fallos, propón fixes."
   - "Divide los cambios actuales en tres commits con mensajes claros y abre un PR."

**Fuera de alcance (v1):**
- Usuarios no técnicos.
- Web app pública multi-tenant.
- App de escritorio con UI propia.

---

## 4. Decisión de plataforma

| Opción | Veredicto | Razón |
|---|---|---|
| App de escritorio con UI propia | ❌ Descartada | Reinventa lo que ya hacen Zed/Cursor; no aporta. |
| Web app | ❌ Descartada | Necesita acceso al sistema de archivos local del dev; un navegador no puede sin un agente local instalado igualmente. |
| **CLI/paquete npm headless (agente ACP)** | ✅ **Recomendada** | Encaja con el público objetivo (devs), distribución trivial vía npm, integración inmediata con editores ACP. |

---

## 5. Objetivos y métricas

**Objetivos v1:**
- Agente ACP funcional que arranca sobre stdio y completa al menos un *prompt turn* end-to-end.
- Cuatro sub-agentes operativos: código, OS, documentación web, Git/VCS.
- Integración verificada con Zed (cliente ACP de referencia).
- Distribución por npm con `npx tu-asistente` funcionando sin instalación previa.

**Métricas iniciales (no vanidad):**
- Tiempo desde `npm install` hasta primera respuesta útil < 2 minutos.
- Cobertura de tests sobre el orquestador > 70%.
- Número de editores compatibles validados ≥ 2 (Zed + uno más).

**Lo que no se mide aún:** DAUs, retención. Demasiado pronto.

---

## 6. Alcance funcional v1

### 6.1. Núcleo del agente
- Implementación del protocolo ACP: `initialize`, `session/new`, `session/prompt`, streaming de updates, manejo de permisos para herramientas.
- Orquestador que decide qué sub-agente invocar según la petición.
- Configuración del proveedor LLM por archivo de config o variable de entorno. **Soporte dual desde v1**:
  - **Cloud:** Anthropic, OpenAI, y cualquier API compatible con OpenAI.
  - **Local:** Ollama y `llama.cpp` (vía servidor HTTP local).
  - El usuario puede mezclar: por ejemplo, modelo cloud para el orquestador y local para sub-agentes simples.

### 6.2. Sub-agentes
Cada sub-agente tiene su propio prompt, sus propias herramientas y su propio contexto. El orquestador decide cuál invocar en cada turno (puede invocar varios en cadena).

- **Sub-agente código:** lectura/escritura de archivos del workspace, búsqueda en código (grep, AST), refactors, generación de tests unitarios cuando se le pida explícitamente.
- **Sub-agente OS/shell:** ejecución de comandos del sistema con permiso explícito por comando. Aquí caen también las invocaciones a runners de tests (`pytest`, `jest`, `go test`), linters, formateadores, builds, etc. No auto-ejecuta nada destructivo.
- **Sub-agente documentación web:** busca y lee documentación oficial actualizada en internet. Sirve para que el agente no se quede limitado al conocimiento congelado del LLM (versiones de APIs, releases recientes, changelogs).
  - Herramientas: cliente de búsqueda (Brave, Tavily, o MCP server equivalente) + fetch HTTP con limpieza de HTML.
- **Sub-agente Git/VCS:** opera sobre el repositorio: commits, ramas, rebase interactivo, pull requests. Es la tarea de desarrollo más universal después de escribir código.
  - Herramientas: `git` CLI con permisos por operación, `gh`/`glab` para PRs, lectura de `git diff` y `git log`. Operaciones potencialmente destructivas (force push, reset duro, borrar ramas) requieren confirmación reforzada.

### 6.3. Herramientas externas
- Soporte para conectar MCP servers configurados por el usuario (filesystem, git, etc.).
- No se reimplementa lo que ya existe como MCP server de calidad.

### 6.4. Fuera de alcance v1
- UI propia.
- Multi-usuario / colaboración en tiempo real.
- Hosting remoto del agente.
- Modelos fine-tuned propios.
- Sub-agentes para diseño, marketing u otras verticales no-código.
- **Sub-agentes adicionales de desarrollo** (debug guiado, revisión de PRs, generación de documentación, análisis de datos): diferidos a v2 según la demanda observada.
- **Adaptador para VSCode.** VSCode no es cliente ACP nativo y construir la traducción equivale a otro mini-producto. Descartado también para v2; reconsiderar solo ante demanda explícita.
- **RAG sobre historial de conversación.** Diferido a v2; en v1 basta sliding window con resumen automático (ver §7.2).
- **Telemetría de cualquier tipo**, ni siquiera opcional anónima. Es una decisión de filosofía, no una limitación de scope.

---

## 7. Arquitectura técnica

### 7.1. Stack
- **Lenguaje:** TypeScript sobre Node.js ≥ 20.
- **Librería ACP:** `@zed-industries/agent-client-protocol` (SDK oficial en TypeScript).
- **Transporte:** stdio (JSON-RPC), tal como define ACP.
- **Orquestación de sub-agentes:** módulo propio simple. Si crece, evaluar LangGraph o el SDK de Anthropic (Claude Agent SDK).
- **Capa de proveedores LLM:** abstracción interna con dos backends desde v1:
  - **Cloud:** Anthropic SDK + cliente compatible con la API de OpenAI (cubre OpenAI, Groq, Together, etc.).
  - **Local:** cliente HTTP que habla con Ollama o `llama.cpp` server.
  - Selección por sub-agente, configurable. Permite por ejemplo orquestador en Claude Sonnet y sub-agente OS en un Llama local.
- **Persistencia:** SQLite local (vía `better-sqlite3`) en una ruta del directorio de configuración del usuario. Un archivo por workspace.
- **Herramientas:** MCP servers de terceros + herramientas internas para los sub-agentes.

### 7.2. Gestión de contexto

Dos problemas distintos, dos soluciones combinadas:

**Persistencia entre sesiones (SQLite).**
Tablas mínimas: `sessions`, `turns`, `messages`, `tool_calls`. Cada `session/new` crea una fila; cada `session/prompt` añade un turn. Permite cerrar el editor y reanudar la sesión exactamente donde se dejó, e inspeccionar el histórico fuera del agente si hace falta.

**Ventana de contexto en runtime (sliding window con resumen).**
En cada llamada al LLM, el agente compone el prompt según esta política:

1. Mantiene siempre los últimos N mensajes completos (ventana corta, configurable, por defecto los 10 más recientes).
2. Si el total de tokens estimados supera el 70 % de la ventana del modelo activo, los mensajes más antiguos se pasan a un proceso de resumen: una llamada barata al LLM los condensa en un párrafo que reemplaza al bloque original.
3. El resumen se persiste en SQLite junto con un puntero a los mensajes originales para auditoría.

Esto evita reventar la ventana sin perder la línea narrativa de la sesión. RAG sobre el historial queda fuera de v1.

### 7.3. Flujo de una petición
1. Editor envía `session/prompt` al agente vía stdio.
2. Orquestador clasifica la intención y elige sub-agente(s).
3. El sub-agente compone el prompt según §7.2 y llama al LLM (cloud o local según config).
4. Posibles llamadas a herramientas, con `session/request_permission` para acciones sensibles.
5. Resultados se transmiten al editor como `session/update` notifications.
6. Cierre del turno con `stop_reason`. Estado se persiste en SQLite.

---

## 8. Empaquetado, distribución e instalación

### 8.1. Empaquetado
- Paquete npm publicado en el registry público.
- Campo `bin` en `package.json` que expone un comando ejecutable (ej. `tu-asistente`).
- Build con `tsup` o `esbuild` a un único archivo JS auto-contenido.
- Compatibilidad probada en Linux, macOS y Windows.

### 8.2. Instalación para el usuario final
Tres caminos soportados:

```bash
# Camino 1: instalación global
npm install -g tu-asistente
tu-asistente --version

# Camino 2: ejecución sin instalar
npx tu-asistente

# Camino 3: clonar el repo (para contribuir)
git clone https://github.com/tu-org/tu-asistente.git
cd tu-asistente
npm install
npm run build
npm link   # expone el binario localmente
```

### 8.3. Configuración en el editor
- Documentar pasos para Zed (archivo de configuración apuntando al binario).
- Documentar pasos para JetBrains y otros plugins.
- Variables de entorno reconocidas, ninguna obligatoria por sí sola pero al menos una requerida según el provider configurado:
  - `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL` (para APIs compatibles).
  - `OLLAMA_HOST` (por defecto `http://localhost:11434`).
- Archivo de config opcional en `~/.config/tu-asistente/config.toml` para mapear cada sub-agente a un proveedor/modelo concreto.

### 8.4. Despliegue (releases)
- CI con GitHub Actions:
  - Tests en cada PR.
  - Publicación automática a npm en cada tag `vX.Y.Z` siguiendo SemVer.
- Sin servidores propios en v1: el agente corre en la máquina del dev, no hay backend.

---

## 9. Seguridad, privacidad y permisos

- Toda ejecución de comandos shell pasa por `session/request_permission` del protocolo ACP.
- Lista negra por defecto de comandos destructivos (`rm -rf`, `dd`, etc.) que requieren confirmación adicional.
- Nunca se envían rutas o contenidos del workspace a servicios externos sin que el sub-agente correspondiente lo justifique en el log.
- Las API keys se leen del entorno, nunca se persisten en el repo ni en logs.
- **Cero telemetría.** No se envía ningún dato de uso, errores, identificadores ni métricas a ningún servidor del proyecto, ni siquiera anonimizado u opcional. Si más adelante se decidiera medir algo, sería con consentimiento explícito y opt-in por defecto, y se trataría como un cambio mayor de filosofía documentado en el changelog.
- La base SQLite local es del usuario: vive en su disco, puede borrarse o inspeccionarse sin nuestro permiso.

---

## 10. Riesgos

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| ACP cambia de spec antes de v1 estable | Media | Pinear versión del SDK; seguir releases de ACP. |
| Coste de API LLM se dispara con sub-agentes | Media | Soporte dual desde v1: el usuario puede asignar sub-agentes a modelos locales; caché de respuestas en SQLite. |
| Modelos locales fallan en cadenas de herramientas largas | **Alta** | Documentar qué modelos locales funcionan razonablemente; permitir fallback automático a cloud si está configurado. |
| Pocos editores compatibles con ACP en 2026 | Media | v1 cubre Zed; añadir JetBrains en v1 vía su plugin oficial de ACP. |
| Solapamiento con Claude Code u otros | Alta | Diferenciador = sub-agentes especializados, ejecución local, agnóstico al LLM, sin telemetría. |
| Complejidad de gestión de contexto degrada UX | Media | Sliding window simple en v1; dejar RAG y memoria avanzada para v2 con datos reales de uso. |

---

## 11. Plan por fases

**Fase 0 — Spike (1-2 semanas):**
Agente ACP mínimo en TypeScript que responde "hola mundo" desde Zed. Capa de proveedores con un único backend (cloud) para validar el flujo. Sin sub-agentes, sin SQLite.

**Fase 1 — MVP (6-8 semanas):**
Sub-agente código + sub-agente OS, ambos con permisos. Capa de proveedores ya con cloud y local funcionando. SQLite para persistencia. Sliding window con resumen automático. Publicado en npm como `0.1.0`.

**Fase 2 — Cobertura completa (4 semanas):**
Sub-agentes documentación web y Git/VCS. Documentación de instalación para Zed y JetBrains. Configuración por archivo `config.toml` para mapear sub-agentes a modelos.

**Fase 3 — Validación (continuo):**
Recoger feedback de devs reales (sin telemetría: feedback explícito en GitHub issues y Discord). Decidir si invertir en RAG, nuevos sub-agentes, o pulir lo existente.

---

## 12. Decisiones tomadas y preguntas abiertas

### Resueltas en v0.3
- **Sub-agentes 3 y 4:** documentación web y Git/VCS. El de datos queda fuera de v1 por baja demanda en el público objetivo (devs generalistas, no data engineers).

### Resueltas en v0.2
- **Modelos:** ambos (cloud y local) desde v1, con configuración por sub-agente.
- **Contexto:** SQLite para persistencia + sliding window con resumen automático al 70% de la ventana. RAG diferido a v2.
- **Telemetría:** cero, ni opcional. Decisión de filosofía.
- **VSCode:** descartado para v1 y v2.

### Pendientes
- ¿Lista de modelos locales recomendados que funcionan bien con tool use complejo? (Validar empíricamente en Fase 1.)
- ¿Granularidad del resumen automático: por turno, por bloque de N mensajes, o por tamaño de tokens? (Empezar con tokens, ajustar con datos reales.)
- ¿Estrategia de versionado de la base SQLite cuando cambie el esquema? (Probablemente migraciones simples con `umzug` o equivalente.)
- ¿Distribución del binario al margen de npm para devs que no tienen Node? (Posible bundle con `pkg` o `bun build --compile` si hay demanda.)
