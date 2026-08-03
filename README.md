# okr-board-mcp

MCP de autoría de documentos vivos: edita el tablero OKR de Bidcom como spec versionado, resuelto contra la capa semántica al renderizar.

## Qué es esto

Un servidor **MCP** que permite editar, de forma conversacional y gobernada (vía Claude),
el tablero estratégico del directorio de Bidcom (OKRs, KPIs, Rocas, Iniciativas). Cada
edición se guarda como un commit en git sobre un **spec** JSON versionado — nunca sobre
el HTML. Un renderer separado (`apps/frontend`) dibuja ese spec y resuelve en vivo los
valores gobernados (`mode:"metric"`) contra la capa semántica de Bidcom.

El modelo mental completo (por qué el spec guarda la pregunta y no el resultado, por qué
el MCP nunca toca el HTML, las fronteras entre el núcleo y los bordes) está en
[`CLAUDE.md`](./CLAUDE.md) — es el brief persistente del proyecto y la fuente de verdad
sobre decisiones, alcance y backlog. Este README es la puerta de entrada operativa: cómo
instalar, compilar, correr y editar. Leelo antes de tocar código si vas a cambiar algo
más que un detalle local.

## Estructura del monorepo

npm workspaces + TypeScript project references (`tsc -b`, no hay script de build a mano
que ordene los paquetes).

| Paquete | Qué es |
|---|---|
| `packages/core` | Núcleo sin conocimiento de MCP ni HTTP: tipos del dominio, pipeline (`runWrite`/`runDryRun`/`runValidate`), validación en cascada, puertos (`SpecStore`, `MetricCatalog`) y sus implementaciones (`GitSpecStore`, `CachedMetricCatalog`). `contracts/okr-board.schema.json` es el schema del spec. |
| `packages/mcp` | Servidor MCP por **stdio** (consumido por Claude Desktop/Code local). `contracts/okr-board-mcp.tools.json` son las 18 tools expuestas; es la fuente de verdad de sus schemas, no se re-declaran en TS. |
| `packages/api` | API HTTP de solo lectura sobre el mismo `core` (`GET /api/boards/:id`, `.../version`) más un endpoint de **preview efímero** (`.../preview`, ver más abajo) — nunca reimplementa validación. |
| `apps/frontend` | El renderer: HTML vanilla que hace `fetch` al API, resuelve métricas, hace polling de cambios y tiene su UI de escritura manual deshabilitada a propósito (la edición real es vía Claude). |
| `scripts/` | `bootstrap.ts` (carga inicial del spec, ya corrido), `serve-frontend.ts` (sirve `apps/frontend` como estático), `refresh-metrics.ts` (ver abajo). |
| `data/` | `despliegue-estrategico-2026.json` (el spec real, versionado en git — **esto es el dato que importa**), `metric-catalog.json` (qué métricas existen), `metric-values-snapshot.json` (valores resueltos de esas métricas). |

## Quickstart

```bash
npm install
npm run build   # tsc -b — compila core -> mcp/api en el orden correcto
npm test        # corre los tests de core y api (85 casos)
```

## Correr todo localmente

Tres procesos independientes, cada uno con su puerto/transporte:

| Proceso | Cómo | Puerto / transporte |
|---|---|---|
| MCP | ver configuración de Claude Desktop/Code abajo | stdio (sin puerto) |
| API | `npm run api` | `:8788` (`PORT` para cambiarlo) |
| Frontend | `npm run frontend` | `:8789` |

**Configurar el MCP en Claude Desktop/Code** (`claude_desktop_config.json` o
equivalente) — usá una ruta **absoluta** al build compilado, no hay campo `cwd`:

```json
{
  "mcpServers": {
    "okr-board": {
      "command": "node",
      "args": ["/ruta/absoluta/a/okr-board-mcp/packages/mcp/dist/src/server.js"],
      "env": { "OKR_MCP_PRINCIPAL": "@tu-usuario" }
    }
  }
}
```

Variables de entorno relevantes (todas opcionales, con default razonable):

- `OKR_MCP_PRINCIPAL` (default `@dionisio`) — quién queda como autor en authz/commits.
- `OKR_API_BASE` (default `http://localhost:8788`) — dónde publica el MCP los previews.
- `OKR_FRONTEND_BASE` (default `http://localhost:8789`) — con qué base arma el `preview_url`.
- `PORT` — puerto del API (`8788`) o del frontend (`8789`) según el proceso.

## Flujo de edición

Con el API y el frontend corriendo, cualquier tool de escritura del MCP acepta
`dry_run: true`: corre authz + concurrencia + validación completa y devuelve el spec
resultante **sin commitear**, y además publica ese resultado en un slot efímero del API
que el frontend renderiza en `http://localhost:8789/?preview=1` — el mismo renderer real,
con un banner de "sin commitear". Recién cuando el usuario confirma, se repite la
llamada sin `dry_run` (o en `false`): ahí sí commitea a git y limpia el preview.

Flujo recomendado: **editar vía Claude → dry_run → mostrar el `preview_url` → confirmar
→ commit real.** Si el API no está corriendo, el `dry_run` sigue funcionando igual, solo
que `preview_url` vuelve `null` (no hay nada navegable, pero el JSON del resultado ya es
útil).

## Refresh de métricas gobernadas

Los KRs/KPIs en `mode:"metric"` no traen el número, traen una referencia. Para
actualizar los valores resueltos contra la capa semántica:

```bash
npm run refresh-metrics -- list          # qué métricas están referenciadas y con qué filtro
npm run refresh-metrics -- apply values.json   # mergea {claveCanonica: numero} en el snapshot
```

`list` no resuelve nada por sí solo — la resolución real (`get_data_context` +
`query_analytics` contra el Analytics MCP) la hace Claude a mano, porque requiere
generar/validar SQL. `apply` solo mergea números ya resueltos.

## Estado y backlog

El detalle de qué está construido, qué decisiones de negocio quedan abiertas y qué
mejoras están propuestas pero no implementadas vive en `CLAUDE.md` (secciones §2, §6 y
§8) — para no mantener la misma información en dos lugares que se desincronizan. Como
resumen de una línea: el núcleo (spec + pipeline + MCP + API + frontend + preview
navegable) está construido y probado de punta a punta, con CRUD completo de las nueve
entidades del schema más edición granular de hitos/scopesQ de iniciativas vía MCP; lo
que falta es sobre todo escritura real desde el frontend (F4, opcional) y decisiones de
negocio puntuales sobre un par de métricas.
