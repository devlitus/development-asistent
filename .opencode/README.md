# 🎭 Equipo de Agentes - Workflow Orquestado con Contexto Detallado

Sistema de desarrollo colaborativo con **Orchestrator** como director de orquesta que coordina especialistas con **contexto detallado** para desarrollo con Bun y TypeScript.

## 🎬 Filosofía del Sistema

**"Una sola voz, múltiples expertos, contexto completo"**

- **Orchestrator** es el ÚNICO que habla con el usuario
- Orchestrator proporciona **CONTEXTO DETALLADO** a cada subagente
- Los subagentes **exploran el codebase** antes de actuar
- Cada subagente completa un **HANDOFF estructurado** al finalizar
- Orchestrator **mantiene un log** de todas las decisiones

## 🎪 Agentes

### 🎯 Orchestrator (Primary)
**Presiona `Tab` para activar**

El director de orquesta. Recibe peticiones del usuario, analiza complejidad, coordina todo el workflow, y mantiene un log detallado.

**Habilidades**:
- Analiza si una tarea es simple o compleja
- Delega a especialistas con contexto detallado
- Mantiene comunicación con el usuario
- Gestiona el flujo de trabajo
- Parsea handoffs de subagentes
- Mantiene log en `docs/orchestrator-log.md`

### 🏗️ Architecto (Subagent)
**Invoca con: `@architecto`**

El arquitecto visionario. Explora el codebase, divide problemas complejos en tareas atómicas.

**Habilidades**:
- Explora el codebase antes de diseñar
- Divide en tareas manejables (15-30 min cada una)
- Escribe tareas en `docs/tasks/`
- Define interfaces y contratos primero
- Completa handoff con diseño completo

### ⚒️ Code-Smith (Subagent)
**Invoca con: `@code-smith`**

El artesano del código. Implementa usando TDD estricto.

**Habilidades**:
- Explora el codebase antes de implementar
- TDD: Test primero, implementación después
- Escribe código limpio y mantenible
- Refactoriza con tests verdes
- Completa handoff con estado de tests

### 🔫 Type-Sheriff (Subagent)
**Invoca con: `@type-sheriff`**

El guardián de la calidad. Revisa código sin modificarlo.

**Habilidades**:
- Explora archivos antes de revisar
- Revisa tipos, seguridad y mejores prácticas
- Identifica bugs y code smells
- Reporta con severidad (Crítico/Mayor/Menor)
- Completa handoff con veredicto

### 🔮 Test-Mancer (Subagent)
**Invoca con: `@test-mancer`**

El maestro de los tests. Busca edge cases y verifica cobertura.

**Habilidades**:
- Explora implementación y tests
- Identifica casos límite faltantes
- Verifica calidad y determinismo de tests
- Encuentra bugs a través de tests
- Completa handoff con hallazgos

### ⚡ Perf-Wizard (Subagent)
**Invoca con: `@perf-wizard`**

El mago de la optimización. Mejora rendimiento sin romper funcionalidad.

**Habilidades**:
- Explora codebase completo
- Identifica cuellos de botella
- Propone optimizaciones medibles
- Mantiene balance rendimiento/legibilidad
- Completa handoff con análisis

## 🔄 Workflow Completo

```
Usuario
  ↓
Orchestrator (Analiza complejidad + Log)
  ├── Simple → Lo hace directamente + Log → Usuario
  │
  └── Complejo → Delega a Architecto con CONTEXTO DETALLADO
                    ↓
              Architecto (Explora + Diseña + Divide)
                    ↓
              Escribe tareas en docs/tasks/
              Completa HANDOFF
                    ↓
              Orchestrator (Parsea handoff + Log)
                    ↓
              Por cada tarea:
                ↓
              Code-Smith (Explora + TDD)
                ├── Escribe tests (ROJO)
                ├── Implementa mínimo (VERDE)
                └── Refactoriza
                Completa HANDOFF
                    ↓
              Orchestrator (Parsea handoff + Log)
                    ↓
              En paralelo con CONTEXTO DETALLADO:
                ├── Test-Mancer (Explora + Verifica)
                └── Type-Sheriff (Explora + Revisa)
                Ambos completan HANDOFF
                    ↓
              Orchestrator (Parsea ambos handoffs + Log)
                    ↓
              Si hay problemas:
                ↓
              Code-Smith (Corrige con contexto)
              Completa HANDOFF
                ↓
              Repite verificación
                    ↓
              Si todo OK → Log + Siguiente tarea
                    ↓
              Si no hay más tareas:
                ↓
              Perf-Wizard (Explora + Optimiza)
              Completa HANDOFF
                ↓
              Orchestrator (Parsea + Log + Finaliza)
                ↓
              Usuario
```

### 📝 Contexto Detallado

Cada vez que Orchestrator delega, incluye:

```markdown
## Contexto del Proyecto
- **Proyecto**: [Nombre/descripción]
- **Stack**: Bun + TypeScript + ESM
- **Estructura actual**: [describe carpetas principales]
- **Patrones existentes**: [arquitectura, convenciones]

## Petición/Tarea
[Descripción detallada]

## Archivos relevantes
- `src/[ruta]` - [qué contiene]
- `test/[ruta]` - [tests existentes]

## Contexto adicional
- [Decisiones arquitectónicas]
- [Dependencias]
- [Notas importantes]
```

### 📤 Handoff de Subagentes

Cada subagente completa al finalizar:

```markdown
## 📤 HANDOFF A ORCHESTRATOR

**Tarea**: [ID/nombre]
**Estado**: [COMPLETADA/PARCIAL/BLOQUEADA]

**Resumen**:
[Qué se hizo en 2-3 líneas]

**Resultados**:
- [Resultado 1]
- [Resultado 2]

**Archivos modificados**:
- `[ruta]` - [cambio]

**Dudas/Preguntas**:
- [Si tiene dudas]

**Próximos pasos sugeridos**:
- [Sugerencias]
```

## 📁 Estructura de Archivos

```
docs/
├── orchestrator-log.md      # Log de decisiones del Orchestrator
├── handoff-template.md      # Template de handoff para subagentes
└── tasks/
    ├── README.md            # Guía de gestión de tareas
    └── ##-nombre-tarea.md   # Tareas individuales

.opencode/
├── agents/
│   ├── orchestrator.md      # 🎯 Director
│   ├── architecto.md        # 🏗️ Diseñador
│   ├── code-smith.md        # ⚒️ Implementador
│   ├── type-sheriff.md      # 🔫 Revisor
│   ├── test-mancer.md       # 🔮 Tester
│   ├── perf-wizard.md       # ⚡ Optimizador
│   └── README.md
└── opencode.json
```

## 🚫 Reglas del Sistema

### Comunicación
1. **SOLO Orchestrator habla con el usuario**
2. Orchestrator proporciona **CONTEXTO DETALLADO** a subagentes
3. Subagentes **exploran codebase** antes de actuar
4. Subagentes **completan HANDOFF** al finalizar
5. Orchestrator **parsea handoffs** y **actualiza log**

### Calidad
1. **TDD obligatorio**: Siempre test primero
2. **Tests verdes obligatorios**: Nunca dejar tests fallando
3. **Revisión obligatoria**: Test-Mancer + Type-Sheriff siempre
4. **Loop de corrección**: Hasta que ambos den OK

### Tareas
1. Una tarea a la vez
2. Tareas atómicas (15-30 min máximo)
3. Interfaces primero, implementación después
4. Documentar decisiones arquitectónicas

## 🚀 Comandos Útiles

```bash
# Desarrollo
bun run index.ts            # Ejecutar
bun run --watch index.ts    # Watch mode
bun run --hot index.ts      # Hot reload

# Testing
bun test                    # Todos los tests
bun test --watch            # Watch mode
bun test --coverage         # Con cobertura
bun test path/to/test.ts    # Específico

# Dependencias
bun install                 # Instalar
bun add <pkg>               # Agregar
bun add -d <pkg>            # Dev dependency

# Build
bun build index.ts          # Compilar
bun build --target node     # Target Node.js
bun build --minify          # Minificado
```

## 🎭 Personalidades

| Agente | Personalidad |
|--------|--------------|
| **Orchestrator** | Profesional, organizado, proactivo, escrupuloso con logs |
| **Architecto** | Visionario, pragmático, detallista, explorador |
| **Code-Smith** | Disciplinado, artesano, meticuloso, explorador |
| **Type-Sheriff** | Exigente, justo, constructivo, explorador |
| **Test-Mancer** | Creativo, meticuloso, malicioso (con el código), explorador |
| **Perf-Wizard** | Analítico, prudente, visionario, explorador |

## 🎨 Colores del Equipo

- 🎯 **Orchestrator**: `#FF6B6B` (Rojo coral)
- 🏗️ **Architecto**: `#4A90E2` (Azul)
- ⚒️ **Code-Smith**: `#F0DB4F` (Amarillo)
- 🔫 **Type-Sheriff**: `#E74C3C` (Rojo)
- 🔮 **Test-Mancer**: `#2ECC71` (Verde)
- ⚡ **Perf-Wizard**: `#9B59B6` (Púrpura)

## 📝 Notas Importantes

- **Contexto detallado**: Orchestrator siempre da contexto completo
- **Exploración previa**: Subagentes exploran antes de actuar
- **Handoff estructurado**: Todos los subagentes usan formato estándar
- **Log persistente**: Orchestrator mantiene registro de todo
- **No suposiciones**: Si falta contexto, se pregunta
- **Ciclo de calidad**: Implementación → Verificación → Corrección → OK