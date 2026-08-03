# CLAUDE.md — MCP de autoría de documentos vivos (tablero OKR de Bidcom)

> Este archivo es el brief persistente del proyecto **y** el prompt maestro de arranque.
> Claude Code lo levanta como contexto. Leelo entero antes de tocar código.

---

## 0. Tu misión

Estás construyendo el **MVP** de un sistema de "documento vivo" para Bidcom: un
servidor **MCP** que permite editar, de forma conversacional y gobernada, el tablero
estratégico del directorio (OKRs y Rocas), guardando el resultado como un **spec**
versionado. El MVP corre local; su diseño es la base directa de la versión final
deployada, sin reescritura.

El objetivo de negocio: que directores y Product Owners tomen decisiones con más
información, en colaboración y con menos burocracia. El objetivo técnico del MVP:
tener el núcleo (spec + pipeline + tools) funcionando de punta a punta con bordes
en su forma más simple (git como store, HTML local como renderer, sin API pública).

---

## 1. El modelo mental — no lo violes nunca

Estos son los principios que sostienen todo. Si un cambio los rompe, el cambio está mal.

1. **El artefacto durable es el SPEC, no el HTML.** El spec es un JSON estructurado
   (pilares, negocios, plataformas, objetivos, KRs, rocas). El HTML es solo el
   *renderer* que lo dibuja. La ecuación es siempre: `render(spec, datos) → vista`.

2. **El MCP edita el spec, NUNCA el HTML.** Las tools (`upsert_roca`, `set_kr_value`,
   etc.) modifican el spec estructurado. El MCP no parsea ni edita markup jamás. Si te
   encontrás tentado a tocar el HTML por partes, pará: lo que se edita por partes es el
   spec; el HTML se re-renderiza entero desde el spec nuevo.

3. **El spec guarda la PREGUNTA, no el RESULTADO.** Un KR gobernado dice
   `value: { mode: "metric", metric: "nmv" }`, no el número. El dato se resuelve en vivo
   contra la capa semántica al renderizar. Por eso el spec puede versionarse en git sin
   exponer cifras sensibles.

4. **El núcleo no conoce los bordes.** El pipeline habla con puertos (`SpecStore`,
   `MetricCatalog`), no con git ni con la capa semántica directamente. El renderer
   recibe un spec con la forma del schema, sin saber de dónde viene. La authz recibe un
   `principal`, sin saber cómo se autenticó. **Mantener estas fronteras limpias es lo que
   hace que el MVP sea la base de la final y no un throwaway.** Un atajo que ensucie una
   frontera es el único error irreversible que podés cometer acá.

5. **Toda escritura pasa por el pipeline.** Un único punto (`runWrite`): authz →
   concurrencia optimista → aplicar cambio acotado → validar en cascada (schema + FKs +
   existencia de métrica) → commit. Ninguna tool escribe por fuera de esto.

---

## 2. Estado actual del repo (lo que YA existe y está probado)

**M1–M7 están construidos y probados de punta a punta** (sesión del 2026-07-30), y
sobre esa base **se sumaron una API HTTP y un frontend propio en un monorepo** (sesión
del 2026-07-30, más tarde el mismo día — ver el plan completo en
`.claude/plans/luminous-jingling-locket.md` si existe, o pedímelo). **No rediseñes estas
piezas sin motivo; construí sobre ellas.**

El repo es un **monorepo con npm workspaces** (`packages/*`, `apps/*`), usando
TypeScript project references (`tsc -b`, no un script de build a mano) para que el
orden core→mcp/api se calcule solo. `npm install && npm run build && npm test` desde la
raíz deja todo compilado y los 85 tests verdes.

- `packages/core/` — el núcleo, **una librería sin conocimiento de MCP ni HTTP**:
  - `src/pipeline.ts` — tipos del dominio, errores tipados, puertos (`SpecStore`,
    `MetricCatalog`), appliers **puros** (`applyChange`), validación en cascada
    (`validateSpec`), pipeline (`runWrite`, `runDryRun`, `runValidate`), y
    `collectValues` (**exportada** — la usa el API para armar `resolved`, ver abajo).
    `findReferrers` maneja tres categorías de referencia (scalar/array/nullableScalar).
  - `src/git-store.ts` — `GitSpecStore` (M1): mutex en proceso + verificación atómica
    de HEAD antes de commitear; versión = sha del blob.
  - `src/metric-catalog.ts` — `CachedMetricCatalog` (M2): TTL cache delante de un
    snapshot (`data/metric-catalog.json`). Ver §2.1.
  - `src/index.ts` — barrel; `mcp`/`api`/`scripts` importan todo `from "core"`, nunca
    rutas relativas cruzando el paquete.
  - `contracts/okr-board.schema.json` — el schema, contrato interno de core (solo
    `pipeline.ts` lo toca).
  - `test/` — `pipeline.test.ts` (32), `git-store.test.ts` (10), `metric-catalog.test.ts`
    (10). **Deben seguir verdes siempre.**
- `packages/mcp/` — servidor MCP stdio (M4), envuelve `core`:
  - `src/server.ts` — `@modelcontextprotocol/sdk`, API de bajo nivel `Server` (no
    `McpServer`) para reusar `contracts/okr-board-mcp.tools.json` tal cual como fuente
    de verdad en vez de re-declarar Zod. Principal desde `OKR_MCP_PRINCIPAL` (env,
    default `@dionisio`). Raíz del repo resuelta con `git rev-parse --show-toplevel`
    (no contar `".."` a mano — ver §2.1).
  - `contracts/okr-board-mcp.tools.json` — **18 tools**: las 7 originales (`get_board`,
    `validate_board`, `upsert_roca`, `set_kr_value`, `upsert_kr`, `upsert_objetivo`,
    `remove_entity`) más `upsert_kpi`, `set_kpi_value`, `upsert_iniciativa`,
    `upsert_onepager_item`, y (sesión 2026-08-03) `upsert_pilar`, `upsert_negocio`,
    `upsert_plataforma` — cierran el hueco de CRUD que el MVP original dejó abierto
    (solo `remove_entity` cubría estas tres entidades) — más (misma sesión)
    `upsert_hito`/`remove_hito` y `upsert_scope_q`/`remove_scope_q`, que editan UN
    hito o UNA nota de alcance de una iniciativa por posición (`index`, 0-based; no
    tienen id propio) sin reemplazar el array completo. Todas las de escritura
    aceptan `dry_run` opcional (M7). Ya no hay hueco de CRUD conocido: las nueve
    entidades del schema (pilar, negocio, plataforma, objetivo, kr, roca, kpi,
    iniciativa, onepager_item) se pueden crear, editar y borrar vía MCP.
    **Deliberadamente sin tool granular:** `onePager[].children[]` — a diferencia de
    hitos/scopesQ, los children son desglose de solo lectura conceptual (por
    canal/marca), no un checklist editable; ver §2.1. `iniciativa.rocaIds` tampoco
    tiene granular (se reemplaza entero vía `upsert_iniciativa`) — nadie lo pidió y
    no tiene el mismo patrón de "checklist que crece de a un ítem" que hitos/scopesQ.
- `packages/api/` — API HTTP de solo lectura (F1), envuelve el **mismo** `core` (no
  reimplementa validación):
  - `src/server.ts` — `node:http` puro (sin framework). `GET /api/boards/:id` →
    `{spec, resolved, version}`; `GET /api/boards/:id/version` (barata, para polling).
    `resolved` usa el mismo path scheme que `collectValues()` (`"krs/k1/value"`, etc.)
    como clave — no metric+filter, porque dos entidades pueden compartir esa
    combinación. `version` es el token real de `SpecStore` (no un contador propio).
    CORS abierto (`*`) — MVP local sin auth de red. Mapea errores a HTTP
    (401/409/422/404) aunque hoy solo 404 es alcanzable (F1 es de solo lectura).
  - `src/metric-resolver.ts` — puerto `MetricResolver` (**distinto** de
    `MetricCatalog.has()`: esto resuelve el VALOR, no solo existencia). Implementación
    MVP `SnapshotMetricResolver` sobre `data/metric-values-snapshot.json` — ver §2.1.
  - `test/metric-resolver.test.ts` (8 casos).
- `apps/frontend/index.html` — **portación del HTML** (vanilla, no React — ver §2.1),
  lee del API en vez de `spec.json`/`localStorage`. `loadData()` hace `fetch` a
  `packages/api` y el adaptador (`adaptSpecToLegacy` y familia) ahora sí resuelve
  `mode:"metric"` contra el mapa `resolved` (a diferencia de la portación M3 anterior,
  que quedó reemplazada — ver §2.1). Polling cada 5s (`POLL_MS`) contra
  `.../version`; si cambió, re-trae el spec completo y re-renderiza, preservando el
  negocio seleccionado. **UI de escritura manual gateada** (`WRITE_ENABLED = false`):
  oculta + las funciones que mutan de verdad quedan bloqueadas — ver §2.1 antes de
  tocar esto. Verificado en navegador real (Playwright) tres veces: HTML servido,
  métrica resuelta, y polling reflejando un write real del MCP sin recargar la página.
- `scripts/` (raíz, no es un package): `bootstrap.ts` (M5, sin cambios de fondo — solo
  pasó a importar `from "core"`), `serve-frontend.ts` (estático para `apps/frontend`,
  proceso separado de `packages/api` a propósito), `refresh-metrics.ts` (mecanismo de
  refresh on-demand para KRs/KPIs en `mode:"metric"`, ver §2.2).

**Auditoría de fidelidad HTML→spec (sesión 2026-07-31):** se comparó el HTML original
recuperado (nunca se commiteó a git; recuperado de un blob dangling vía `git fsck`)
contra `data/despliegue-estrategico-2026.json` campo por campo (622 registros: pilares,
negocios, plataformas, objetivos, krs, rocas, kpis, iniciativas, onePager con nodos
anidados) y contra `apps/frontend/index.html` función por función (diff de archivo
completo). Resultado: **cero pérdida de datos, cero drift de lógica de negocio** — los
únicos cambios reales fueron los ya documentados en esta sección (adaptador de API,
gateo de escritura) más una escritura de demo posterior al bootstrap (roca `r1`, ver §8).
El único hallazgo real fue que `toggleRocaKr` no pasaba por `guardWrite()` a diferencia
de las demás funciones que mutan — corregido en la misma sesión. No hace falta
re-auditar esto salvo que se vuelva a tocar el bootstrap o la portación del HTML.

### 2.1 Decisiones que no estaban en el brief original (ninguna sesión)

- **`kpis`/`iniciativas`/`onePager` se agregaron al schema gobernado** (el brief original
  del §0 solo hablaba de "OKRs y Rocas"). Decisión explícita del usuario. `kpis` cuelga
  de pilar+negocio (no de un objetivo); `iniciativas.hitos` reemplaza el `krs` anidado
  original (mismo dato, otro nombre para no confundir con la entidad `kr` real, sin id
  propio — se reemplaza el array entero al editar); `onePager` es recursivo
  (`$defs/onePagerNode`), solo el nodo raíz de cada fila es gobernable (`value`), los
  `children` (desglose por canal/marca) son de solo lectura conceptual.
- **`preguntaFeedback` quedó FUERA del spec gobernado**, aunque el usuario pidió incluir
  "kpis/onePager/iniciativas/preguntaFeedback" en bloque: es estado de interacción de UI
  (qué tarjeta de feedback tocó el usuario), no contenido de negocio — versionarlo en git
  crearía un commit por click. `quarters` también quedó como constante local (no es ni
  OKR ni Roca). Si esto se quiere revisar, avisar antes de tocar el schema.
- **5 KPIs de pilar "Regionalización" (kpi32–36) se excluyeron del bootstrap**: referencian
  `negocioId:"regional"`, un negocio dado de baja (ver migración en `mergeWithDefaults()`
  del HTML original), y están vacíos (`actual`/`target` null). Si Regionalización vuelve
  a tener presupuesto real, recrearlos referenciando un negocio vigente.
- **`MetricCatalog` NO llama en vivo a la capa semántica todavía**: usa un snapshot
  (`data/metric-catalog.json`) sembrado a mano desde `get_data_context` (§4 del SKILL:
  NMV, GMV, TSI, TRX, RETURN_*, DDI, etc.), con cache TTL de 5 min delante. Familias
  paramétricas (`GROSS_PROFIT_SIN_REFUSA_*`, `CURRENT_STOCK_COST_*`) matchean por
  prefijo, no por enumeración exacta (evita fabricar combinaciones no verificadas).
  Refrescar el snapshot es manual por ahora — la migración a una llamada en vivo es un
  cambio de implementación detrás del mismo puerto, no toca el pipeline. Lo mismo aplica
  a `data/metric-values-snapshot.json` (`MetricResolver`) — ver §2.2 para el mecanismo
  de refresh on-demand construido para ambos.
- **`tsconfig` usa `module`/`moduleResolution: "nodenext"`** (no `"commonjs"`/`"node"`):
  el SDK de MCP publica subpaths vía `exports` map (`@modelcontextprotocol/sdk/server`,
  etc.) que la resolución clásica de Node no entiende. No revertir esto sin volver a
  chequear que el SDK siga resolviendo.
- **Monorepo: `tsc -b` (project references), no un script de build a mano.** npm
  workspaces no ordena `npm run build --workspaces` topológicamente por sí solo; en vez
  de mantener un script que compile core-antes-que-mcp/api a mano (se desactualiza en
  silencio si se agrega un paquete), cada `packages/*/tsconfig.json` declara sus
  `references` y `tsc -b` arma el orden solo. Es nativo de `typescript` (ya
  dependencia), no "tooling extra" en el sentido de sumar Turborepo/Nx.
- **La raíz del repo se resuelve con `git rev-parse --show-toplevel`**, no contando
  `".."` desde `__dirname` — mover `server.ts` a `packages/mcp/dist/src/` cambió la
  profundidad real (4 niveles, no 2) y un conteo a mano falla en silencio (puede
  escribir en un lugar distinto del que lee, sin tirar error). Mismo criterio aplicado
  en `packages/api/src/server.ts` y en el test de integración de `metric-catalog`
  (`npm test --workspace=core` corre con cwd=`packages/core`, no la raíz).
- **`MetricResolver` es un puerto nuevo, en `packages/api`, no en `core`**: a diferencia
  de `MetricCatalog.has()` (existencia, la usa el pipeline de escritura), esto resuelve
  el VALOR para mostrar — el pipeline de escritura nunca lo necesita, así que no vive en
  `core`. `resolve()` no lanza: `{value, error?}`, para que una métrica que falla no
  tumbe toda la respuesta del board.
- **Vanilla, no React, para `apps/frontend`** (decisión mía, pedida explícitamente en el
  brief: "proponé y justificá"): el HTML ya tenía la vista completa y correcta,
  verificada en navegador. React es la fila de "versión final" en la tabla de §5 —no es
  una idea nueva, solo no es ahora. La navegación real (verificada contra el HTML, no
  asumida del brief) es Pilares/Negocios/Plataformas arriba; **por negocio**, 5 tabs
  (Resumen Ejecutivo, One Pager, OKRs, Rocas, **Iniciativas Estratégicas**); **por
  plataforma**, solo 3 (sin One Pager ni Iniciativas) — son estructuras distintas, no
  hay que unificarlas.
- **`renderer/despliegue_estrategico.html` y `scripts/preview-server.ts` se
  eliminaron** (a pedido explícito del usuario) una vez que `apps/frontend` + el API
  los reemplazaron — ya no hay dos copias del HTML divergiendo.
- **La UI de carga manual del HTML (Cargar Datos/Agregar/Importar JSON) se ocultó, no se
  borró** (`WRITE_ENABLED = false` en `apps/frontend/index.html`): además de ocultar los
  botones, las funciones que de verdad mutan (`saveData()` — verificado función por
  función, no por nombre) quedan bloqueadas por si algún camino de UI no se encontró al
  ocultar. `Exportar JSON` y `preguntaFeedback` quedan sin gatear (no escriben dato
  gobernado). F4 (no implementada) es recablear estas mismas funciones al API, no
  reconstruir la UI.

### 2.2 Migración literal→metric: piloto + primera pasada completa (sesión 2026-07-31)

Hasta esta sesión, los 205 valores gobernables del spec (135 KRs + 35 KPIs + 19 nodos
raíz de onePager) eran **100% `literal`** — cero conectados a la capa semántica, pese a
que la tubería (`MetricCatalog`, `MetricResolver`) estaba lista desde F1. Esta sesión
hizo dos pasadas: un piloto chico (2-3 ítems, confirmado con el usuario antes de tocar
el spec real) y, después, una revisión sistemática de **los 135 KRs + 35 KPIs completos**
contra el catálogo real del Analytics MCP (a pedido explícito del usuario: "alineá los
que ya estén gobernados, los que necesiten definición no los sumes a refresh-metrics").

**Mecanismo de refresh on-demand (`scripts/refresh-metrics.ts`, `npm run
refresh-metrics`):** sin cron todavía, se dispara a mano. `list` lee el spec, agrupa los
`value.mode==="metric"` por clave canónica (misma que usa `MetricResolver`) y avisa si
una clave la comparten entidades de distinto tipo (`krs` vs `kpis` vs `onePager` — ver
el hallazgo de escala más abajo, por qué esto importa). `apply <values.json>` mergea
`{claveCanonica: numero}` en `data/metric-values-snapshot.json` sin pisar claves no
incluidas (así conviven los fixtures de test con valores reales — ver el propio
`source` del snapshot). La resolución real (`lookup`/`get_data_context`/
`query_analytics` contra el Analytics MCP) la sigue haciendo Claude a mano: necesita
generar/validar SQL, no es determinística, no tiene sentido scriptearla.

**Migrados a `mode:"metric"` vía el servidor MCP real (commits reales, no simulados —
"valor de kpi kpi1/kpi17 (metric)", "valor de k22 (metric)"):**
- `k22` ("Tasa de devoluciones total") y `kpi17` ("Tasa de devoluciones", pilar
  Postventa) → `RETURN_RATE_QTY`, `filter:{period:"2026-06"}`. **Con dato real**: 0.0217,
  resuelto vía `query_analytics` contra
  `onepager.onepager_returns_by_order_date_monthly` (`kpi_code =
  'RETURN_RATE_QTY_BY_ORDER_DATE'`). Verificado en el API (`resolved["krs/k22/value"]`)
  y en navegador real (Playwright): "ACTUAL 2.17 %" con badge DG en la pestaña OKRs de
  Experiencia de Cliente.
- `kpi1` ("GMV Ventas Totales") → `GMV`, `filter:{period:"2026-YTD"}`. **Sin dato
  todavía** — ver pregunta abierta de moneda más abajo. `MetricResolver` devuelve `null`
  con gracia (no rompe el board); no hay número visible hasta resolverlo.
- `kpi28` ("% de ventas en Fulfillment sobre el global") → `PCT_FF_NMV`,
  `filter:{period:"2026-06"}`. **Con dato real**: 0.2318 (23,18%), resuelto contra
  `onepager_kpi_values` (`kpi_code LIKE 'PCT_FF_NMV%'`). Confirmado por `get_data_context`
  que el denominador de `PCT_FF_NMV`/`PCT_FF_TSI` es **siempre el total global**, nunca
  por canal — por eso `k5` ("FULL sobre el TGMV **de MercadoLibre**", un denominador
  distinto) quedó afuera, ver más abajo.
- `k25` ("Reputación Bidcom en Google") → `REVIEWS_AVG_RATE`, `filter:{period:"2026-06"}`.
  **Con dato real**: 4.77 (★). Confirmado con una query real que `brand`/`channel` son
  `NULL` en las 6 tablas mensuales más recientes de `onepager_kpi_reviews_monthly` — hoy
  no hay desagregación por marca, solo un agregado único de toda la compañía. Por eso
  `k11` (reputación específica de Gadnic) quedó afuera: no hay forma de aislar ese dato.
- `kpi5` ("% Mercadería con Aging > 120 días") → `PCT_NMI_AGING` (sin filtro — es un
  snapshot puntual, no una serie mensual: `onepager_kpi_aging` tiene una sola fila por
  `kpi_code`, `year_month` siempre `NULL`). **Migrado, pero SIN dato en el snapshot
  todavía**: la query real dio 0.7807 (78%), muy lejos del target existente (0.10 = 10%,
  8x de gap). Puede ser un problema real de negocio o un mismatch de alcance con "%
  Mercadería Parada" — no lo suficientemente claro como para publicarlo sin que alguien
  lo confirme. Mismo patrón que `kpi1`: estructuralmente alineado, valor pendiente.

**Migrados con dato real, listos para refrescar:** `k22`, `kpi17`, `kpi28`, `k25` (4 de
205). **Migrados sin dato, pendientes de una decisión de negocio:** `kpi1`, `kpi5` (no
están en `data/metric-values-snapshot.json` — `MetricResolver` devuelve `null` con
gracia para ambos).

**Excluidos de la migración (necesitan una definición nueva o no tienen equivalente
gobernado — no se tocaron, siguen `literal`):**
- **"Utilidad GNI" (`k1`, `k12`):** el término "GNI" no aparece en ningún lado del
  diccionario/glosario del Analytics MCP (`get_data_context` completo, cero matches) —
  no hay forma de saber a qué métrica gobernada corresponde sin inventarlo.
- **Márgenes en U$S (`kpi2` Margen Bruto, `kpi3` Margen Operativo, y por extensión `k12`
  "32 Mio USD Utilidad GNI"):** mismo problema de moneda que `kpi1` — los prefijos
  `GROSS_PROFIT_*`/`NET_PROFIT_*` solo existen en ARS.
- **TGMV (`k2`, `k3`, `k4`, `k5`, `k5b`, `k9`, `k17`):** "TGMV" no es una métrica
  gobernada (el catálogo tiene `GMV`/`NMV`, no `TGMV`) y la mayoría son ratios
  (canal-propio/total, terceros/total) que requerirían una definición nueva. `k5`
  específicamente: pedía FULL sobre TGMV **de MercadoLibre**, pero `PCT_FF_NMV` está
  definido con denominador global — no es el mismo cálculo (ver `kpi28` arriba, que sí
  matcheó porque pide "sobre el global").
- **Aging por rango (`k15` 120-300 días, `k16` >300 días):** el único aging gobernado
  (`PCT_NMI_AGING`) es un único umbral fijo (>120 días); los rangos acotados
  necesitarían una query nueva, no están pre-calculados.
- **Recupero de logística inversa (`k18`, `kpi11`):** `RECOVERY_RATE` en el catálogo
  significa "% del NMV por productos refaccionados/usados/con warranty extendida" — un
  concepto de negocio distinto a "recupero de valor al procesar devoluciones/reprocesos
  sobre PVP original". Nombre parecido, definición distinta — no es el mismo dato.
- **Reputación Gadnic (`k11`):** ver arriba — `REVIEWS_AVG_RATE` no tiene desagregación
  por marca hoy.
- **Calificación compradores (`kpi22`):** pide escala 1-10, pero `REVIEWS_AVG_RATE` está
  definido en escala 1-5 (estrellas) — no es la misma escala, probablemente otra fuente
  de datos (rating de comprador de MercadoLibre, no reseñas de producto).
- **OTIF/OTD/SLA (`kpi18`, `k23`, `k24`):** no existe ninguna métrica de puntualidad de
  entrega en el catálogo (los `DDI_*` son velocidad de rotación de inventario, un
  concepto distinto).
- **Bidcom Agro (`ka1`–`ka31`):** confirmado por `get_data_context` — Agro es una unidad
  de negocio separada (BU 3), **explícitamente excluida de todas las métricas de este
  repo (ADR-0019)**. `channel='AGRO'` existe como dimensión dentro de e-commerce (un
  segmento de productos agro vendido por los canales normales) pero es un concepto
  distinto a la unidad de negocio Bidcom Agro que describen estos KRs.
- **Todo lo demás** (`k6`–`k10`, `k13`, `k14`, `k19`–`k21`, `k26`–`k31`, `kf1`–`kf19`,
  `kt1`–`kt25`, `kmkt1`–`kmkt28`, y la mayoría de los KPIs restantes): son KRs de
  proceso/cualitativos (Implementar, Documentar, Lanzar…), de dominios que este
  Analytics MCP no cubre (RRHH, CSAT/NPS por encuesta, ACOS/POAS de marketing, sistemas
  de ticketing de soporte), o simplemente no tienen un equivalente gobernado evidente.
  No se listan uno por uno acá — si en el futuro la capa semántica gana cobertura nueva
  (encuestas, marketing, Agro), vale la pena repetir este escaneo.

**Fix real encontrado y corregido:** `krValueToLegacy()` en `apps/frontend/index.html`
hacía passthrough directo del valor resuelto, sin normalizar. Los KRs guardan "%" como
número entero (`k1.target=10`) pero los KPIs lo guardan como fracción 0-1
(`kpi17.target=0.03`) — inconsistencia preexistente en el spec (no introducida por esta
sesión), invisible hasta ahora porque ningún KPI con target-fracción tenía `actual`
real todavía. Como `k22` y `kpi17` comparten `metric`+`filter`, `MetricResolver` solo
puede devolver un número — no puede servir "2.17" a uno y "0.0217" al otro con el
diseño actual. Se resolvió guardando siempre el valor **crudo** (fracción 0-1, tal como
lo define la capa semántica — ninguna escala inventada) y agregando un ×100 en
`krValueToLegacy` **solo** para paths que empiezan con `krs/` y `unidad==='%'` (KPIs,
hitos de iniciativas y onePager no se tocan).

**Preguntas abiertas — resueltas 2026-08-03, ver §2.3 (se dejan acá para el contexto de
cómo se llegó a cada una):**
- **Moneda de `kpi1`:** el catálogo gobernado solo tiene `GMV` en ARS (`GMV_%` en
  `onepager_kpi_values`) — no existe `GMV_USD` (a diferencia de `NMV`, que sí tiene
  `NMV_USD` vía `usd_ars_daily.selling_rate`). `kpi1` pide U$S, target 350M. Opciones
  sobre la mesa: construir una conversión GMV→USD nueva (no validada aún como eval
  canónico del Analytics MCP — sería una definición nueva, no inventarla sin más),
  corregir unidad/target de `kpi1` a ARS, o migrar otro KPI en su lugar. Mismo problema
  de fondo que `kpi2`/`kpi3` (ver exclusiones arriba).
- **Valor de `kpi5` (aging):** `PCT_NMI_AGING` dio 78% contra un target de 10% (8x de
  gap) — puede ser un problema real de stock parado, o un mismatch de alcance entre "%
  Mercadería Parada" (la definición gobernada) y lo que el KPI realmente quiere medir.
  Confirmar antes de agregarlo a `data/metric-values-snapshot.json`.
- **Revisión más amplia de la convención "%":** el fix de escala tapa el caso concreto
  de `RETURN_RATE_QTY` compartido entre `k22`/`kpi17` (y ahora también aplica en general
  a cualquier KR "%" migrado — `k25` no lo necesitó por ser `★`, no `%`). No se auditaron
  los KRs/KPIs restantes que **todavía son `literal`** para confirmar que siguen el mismo
  patrón (entero en KRs, fracción en KPIs) antes de una futura migración de un campo "%"
  — sobre todo si lo comparte un KR y un KPI como en el caso ya resuelto.

### 2.3 Cierre de las preguntas abiertas de §2.2 (sesión 2026-08-03)

Las tres preguntas abiertas de §2.2 se resolvieron con el usuario (decisión de negocio,
no técnica) y se aplicaron vía el servidor MCP real:

- **`kpi1` (moneda):** el usuario eligió usar `NMV_USD` en vez de construir una conversión
  GMV→USD nueva o redefinir el KPI en ARS. Renombrado de "GMV (Ventas Totales)" a "NMV
  (Ventas Totales)" (`upsert_kpi` — ya no mide lo mismo, el nombre tenía que reflejarlo) y
  migrado a `metric:"NMV_USD", filter:{period:"2026-YTD"}` (`set_kpi_value`). **Con dato
  real**: USD 151.637.207, de `kpi_code LIKE 'NMV_USD%'` en `onepager_kpi_values`
  (`sales_type='order'`, `year_month` 2026-01 a 2026-08), excluyendo `AGRO`/`OTHERS` por la
  columna `channel` real (no por prefijo del `kpi_code`, que mezcla canal y marca en el
  mismo string — confirmado revisando las 48 variantes reales de `NMV_USD_*`).
- **`kpi5` (aging):** re-confirmado contra `get_data_context` que "mercadería parada" es
  sinónimo exacto de `PCT_NMI_AGING` en el glosario del Analytics MCP (no una definición
  distinta) — la duda de mismatch de alcance de §2.2 queda descartada, es la métrica
  correcta. El usuario decidió publicar el dato real tal cual. **Con dato real**: 0.7824
  (78,24%), re-consultado el mismo día (era 0.7807 tres días antes — es un snapshot
  puntual de `onepager_kpi_aging`, se espera que se mueva día a día). Sigue muy por encima
  del target (0.10) — es un gap real de negocio, no un error de definición.
- **Convención "%" en el resto de literales:** auditados los ~85 KRs/KPIs `literal` con
  `unidad:"%"` del spec real. La convención (entero en KRs, fracción en KPIs) se cumple en
  todos salvo uno (ver fix de `k18` abajo). `k7`, `kf4` y `kmkt4` tienen targets `< 1` pero
  son porcentajes genuinamente chicos (tasa de reclamos en garantía Gadnic, costos de
  estructura de Finanzas sobre GMV, participación de un asistente virtual de ventas) — no
  son excepciones a la convención, así que no hace falta tocarlos.

**Segundo fix real encontrado y corregido (independiente de la migración a `metric` — `k18`
sigue `literal`, ver exclusión en §2.2):** `k18` ("Incrementar el recupero de valor de
logística inversa...", `sentido:"mayor"`, `target:65`) tenía `actual:0.97` — un valor casi
con certeza guardado en fracción (0.97 = 97%) en un KR que usa entero en el resto de sus
campos, mostrando en el tablero un fracaso casi total donde probablemente había una
**superación** del target. El usuario confirmó corregirlo; ahora `actual:97` vía
`set_kr_value`.

**Estado de la migración tras esto:** 6 de 205 valores gobernables en `mode:"metric"` con
dato real (`k22`, `kpi17`, `kpi28`, `k25`, `kpi1`, `kpi5`). Cero `mode:"metric"` sin dato
pendiente — las dos preguntas de moneda/valor que lo causaban ya están resueltas. El resto
sigue `literal` a propósito (sin equivalente gobernado limpio, ver exclusiones en §2.2).

---

## 3. Alcance del MVP (lo que tenés que construir)

Bordes en su forma más simple. Cada tarea implementa un puerto o conecta una pieza,
sin tocar el núcleo.

- **M1 · `SpecStore` sobre git.** Implementá el puerto `SpecStore` (`readHead`/`commit`)
  guardando el spec como archivo (`data/spec.json`) en el repo. `readHead` devuelve el
  spec + un token de versión (ej: el sha de HEAD del archivo o un contador). `commit`
  **debe verificar atómicamente** que el HEAD sigue siendo `expectedVersion` antes de
  escribir; si cambió, lanzar `ConcurrencyError`. Cada commit = una versión (historial,
  diff y rollback gratis vía git).

- **M2 · `MetricCatalog` adaptado a la capa semántica.** Implementá el puerto
  `MetricCatalog.has(metric)` consultando el catálogo de métricas gobernadas de Bidcom
  (el diccionario de métricas del `SKILL.md` / `get_data_context` del Analytics MCP).
  **Cacheá** el resultado (TTL corto) para no machacar la capa semántica en cada
  validación.

- **M3 · Separar el renderer del dato (cambio quirúrgico en el HTML).** Modificá
  `despliegue_estrategico.html` para que, en vez de leer `defaultData`/`localStorage`,
  haga `fetch('spec.json')` y dibuje desde ahí. Es un cambio acotado a la función de
  carga de datos — **no reescribas las ~2.900 líneas de vistas.** El objetivo: que el
  HTML pase de "blob autónomo" a "renderer de un spec externo".

- **M4 · Servidor MCP (transporte + wiring).** Un servidor MCP en Node/TypeScript que
  exponga las 7 tools de `okr-board-mcp.tools.json` y cablee cada `tools/call` al
  pipeline. Para el MVP usá transporte **stdio** (lo consume Claude Desktop/Code local;
  sin HTTP ni auth de red todavía). El `principal` en el MVP sale de la config local.

- **M5 · Bootstrap del spec.** Script único que extraiga el `defaultData` del HTML
  actual y lo convierta en el `data/spec.json` inicial (formalizado según el schema:
  envelope `doc` + `value` con `mode:"literal"` para los KRs cargados a mano). Validá el
  resultado contra el schema antes de commitear.

- **M6 · Loop de preview local.** Un `http.server` (o `npx serve`) que sirva el HTML +
  `spec.json`. Flujo demostrable: editás vía Claude → el MCP reescribe `spec.json` →
  refrescás el navegador → ves el cambio. Esto **simula el deploy** sin deployar nada.

- **M7 · Preview antes de confirmar (recomendado — ver §6).** Un modo dry-run que
  corra el pipeline hasta la validación **sin commitear** y devuelva el spec resultante,
  para que Claude pueda mostrar la sección afectada y recién commitear cuando el usuario
  confirma. Reusa todo el pipeline salvo el paso de commit.

---

## 4. Restricciones duras (qué NO hacer)

- **No editar el HTML por partes ni parsear markup.** Se edita el spec.
- **No meter datos (números) en el spec.** Los KRs gobernados llevan referencia
  (`metric`), no valores. Solo los KRs en `mode:"literal"` llevan número, y son datos
  cargados a mano que migrarán a `metric` con el tiempo.
- **No hardcodear fechas de eventos** (Hot Sale, Cyber Monday, etc.). Si un filtro
  necesita fechas de evento, se resuelven contra el catálogo gobernado, nunca a mano.
- **No deployar en Google Workspace / Apps Script.** Reintroduce el token único, quotas
  y el modelo frágil que descartamos. Workspace es proveedor de **identidad** (login
  OIDC en la versión final), no de **hosting**.
- **No introducir un "token maestro" de una cuenta única.** La identidad es por usuario.
- **No romper las fronteras del §1.4.** El núcleo no importa git, ni la capa semántica,
  ni detalles de transporte.
- **No bajar la cobertura:** si tocás el núcleo, los 14 tests siguen verdes y agregás
  los que correspondan. Todo cambio de contrato se refleja en el schema y se re-valida.

---

## 5. El camino a la versión final (para que tus mejoras estén alineadas)

El MVP es la versión final con los bordes en modo simple. Esto NO se construye ahora,
pero conocelo para no tomar decisiones que lo bloqueen.

| Pieza | MVP (ahora) | Versión final |
|---|---|---|
| Spec (schema) | igual | **igual** |
| Pipeline + validaciones | igual | **igual** |
| Tools del MCP | iguales | **iguales** |
| Authz (el chequeo) | igual (principal local) | **igual** (principal del token OIDC) |
| Store (`SpecStore`) | git / `spec.json` | Postgres |
| Renderer | HTML actual con `fetch` | app propia bajo el dominio, con design system |
| Entrega | `http.server` local | API HTTP + proxy de auth (Cloudflare Access / ALB OIDC) |
| Identidad | config local | Workspace OIDC |
| Secretos | `.env` local | secret manager (least privilege, rotación) |
| Datos de KR | mayormente `literal` | mayormente `metric` (gobernados) |

Las primeras cuatro filas son el corazón y **no cambian**. Todo lo demás es una
sustitución detrás de un puerto ya definido. Ese es el contrato con el futuro.

---

## 6. Mejoras sugeridas (alineadas al objetivo) — proponé más

Estas son mejoras que **sirven al objetivo** (decidir mejor, gobernanza, camino a la
final). Algunas conviene hacerlas en el MVP; otras son para después. Evaluá y proponé.

- **Commit atómico real en el git `SpecStore`, multi-proceso:** hoy `GitSpecStore` serializa
  el check+commit con un mutex **en proceso** (`packages/core/src/git-store.ts`) — correcto
  mientras el único escritor sea el servidor MCP. El día que un segundo proceso escriba
  (ej: F4, API aceptando writes) el mutex en proceso ya no alcanza — hace falta un lock real
  (flock de archivo) para que el check+commit siga siendo atómico entre procesos. No urgente
  hoy (un solo escritor); si se encara F4, encarar esto primero o junto.
- **Migración progresiva literal→metric:** arrancada 2026-07-31, preguntas abiertas
  cerradas 2026-08-03 (ver §2.2/§2.3) — de 205 valores gobernables, 6 ya son `metric` con
  dato real (`k22`, `kpi17`, `kpi28`, `k25`, `kpi1`, `kpi5`) y cero quedan sin dato. Se
  hizo un escaneo completo de los 135 KRs + 35 KPIs contra el catálogo real — el resto
  queda `literal` a propósito, sin equivalente gobernado limpio (lista completa y por qué
  en §2.2). Mecanismo de refresh on-demand en `scripts/refresh-metrics.ts`. Si la capa
  semántica gana cobertura nueva (encuestas, marketing, Agro), vale repetir el escaneo —
  la convención de escala/unidad ("%" entero en KRs, fracción en KPIs) ya se auditó
  completa en §2.3 y está sana salvo el fix de `k18` ya aplicado.
- **Confirmar el significado de `boards`** (`comite` / `direccion_general` / `okr2026`,
  hoy heredados de los flags `com`/`dg`/`okr2026` del HTML) con el equipo.
**Regla para mejoras:** antes de implementar algo fuera del alcance del §3, listalo como
propuesta con su justificación y esperá confirmación. Mejoras que sirvan al objetivo,
no features por agregar. No conviertas el MVP en un Notion interno; la disciplina es
un solo primitivo afilado (el spec) que crece por capas.

---

## 7. Cómo trabajar

- **Validá todo, siempre.** El schema valida los specs; los tests validan el pipeline;
  el bootstrap valida su salida antes de commitear. Si algo no se puede verificar, decilo.
- **Trabajá el núcleo con funciones puras y testeables** (como ya está `applyChange`).
  La lógica de negocio no debe necesitar infraestructura para probarse.
- **Mantené los contratos como fuente de verdad:** si cambia el modelo, primero el
  schema y los contratos de tools, después el código, después los tests.
- **Sé explícito con las operaciones destructivas:** `remove_entity` con `cascade` debe
  pedir confirmación del usuario antes de ejecutarse.
- **Comunicá en los mensajes de commit qué operación acotada se hizo** (el pipeline ya
  arma una descripción; usala).

---

## 8. Definición de "MVP terminado"

- [x] `SpecStore` sobre git implementado, con commit atómico y concurrencia optimista.
      (`packages/core/src/git-store.ts`, 10 tests.)
- [x] `MetricCatalog` conectado a la capa semántica, con cache. (`packages/core/src/metric-catalog.ts`;
      snapshot sembrado a mano por ahora, no llamada en vivo — ver §2.1.)
- [x] Servidor MCP stdio exponiendo las tools (18: las 7 originales + 4 de
      kpis/iniciativas/onePager + 3 de pilares/negocios/plataformas + 4 granulares de
      hitos/scopesQ, sesión 2026-08-03 — ver §2), cableadas al pipeline. Probado con un
      cliente JSON-RPC real por stdio (`initialize` → `tools/list` → `tools/call`), no
      solo compilado.
- [x] `data/despliegue-estrategico-2026.json` bootstrapeado desde el HTML actual y
      validado contra el schema. (El nombre real es `data/<doc_id>.json`, no
      literalmente `spec.json` — `GitSpecStore` nombra por `docId`.)
- [x] HTML modificado para renderizar desde el spec (ya evolucionó de nuevo — ver §8.1:
      `apps/frontend` ahora lee del API, no de `fetch('spec.json')` directo).
- [x] Loop local editar → (preview/dry_run) → confirmar → refrescar — ya evolucionado
      a editar → API → polling, ver §8.1.
- [x] Los 14 tests originales siguen verdes (ahora 32 con los casos nuevos) + tests
      nuevos para `SpecStore` (10) y `MetricCatalog` (10). 52 en `packages/core`.
- [x] Demo end-to-end: `upsert_roca` marcó r1 como completada vía el servidor MCP real
      (no un fake) → commit en git (`git log`, diff de 4 líneas) → refresh del HTML en
      navegador → cambio visible. Ver commit "roca r1 actualizada por @dionisio".

### 8.1 Definición de "API + frontend terminado" (plan aparte, mismo día)

Fases F0–F3 del plan de monorepo completas y verificadas; **F4 (escritura desde el
frontend) es opcional y no se implementó** — el plan explícitamente la deja para
después. Ver §2 para dónde vive cada pieza.

- [x] F0: monorepo (`packages/core`, `packages/mcp`) con `tsc -b`, sin cambiar lógica.
      60 tests verdes, MCP relocalizado responde igual por stdio real.
- [x] F1: `packages/api` de solo lectura + `MetricResolver`. Verificado migrando un KR
      real (`k23`, sin dato) a `mode:"metric"` vía MCP, confirmando que el API lo
      resuelve, y restaurándolo — no quedó dato de prueba en el board real.
- [x] F2: `apps/frontend` (portación vanilla del HTML) lee del API, resuelve métricas de
      verdad (a diferencia de la portación M3 anterior, que quedó reemplazada — ver
      §2.1), UI de escritura manual gateada. Verificado en navegador real.
- [x] F3: polling cada 5s contra `.../version`. Verificado con un write real del MCP
      reflejado en el frontend SIN recargar la página.
- [ ] F4 (opcional, no implementada): `POST /api/boards/:id/...` 1:1 con las tools del
      MCP, recablear la UI gateada del frontend a esos endpoints.

---

## 9. Contexto de dominio (Bidcom)

- **Bidcom** es un e-commerce multicanal (MercadoLibre, WEB, Marketplaces, Offline, B2B,
  Agro). El tablero modela pilares estratégicos, OKRs por negocio/plataforma, KRs con
  meta/actual, y Rocas (prioridades trimestrales estilo EOS).
- **La capa semántica** (Analytics MCP sobre BigQuery) es la fuente única y gobernada de
  las métricas de negocio (NMV, TGMV, márgenes, devoluciones, aging, etc.), definidas en
  el `SKILL.md`. El flujo correcto para resolver un dato: `get_data_context` primero
  (schema + reglas + fechas de eventos verificadas), después la consulta. Nunca inventar
  definiciones ni fechas. Este MCP **no resuelve datos** — eso es del renderer/Analytics
  MCP; este MCP solo maneja el spec. La costura entre ambos es la referencia `metric`.
- **Gobernanza:** las definiciones se homologan una vez y todos los documentos las
  heredan. Es lo que hace que el número en el que confía el directorio sea uno solo.

---

**Arranque sugerido:** leé los cuatro archivos de `contracts/` y `src/pipeline.ts`,
corré los tests para confirmar que están verdes, y proponé un plan para M1–M6 (más M7 si
coincidís en que conviene) antes de escribir código. Si algo de este brief te parece
que se puede mejorar para el objetivo, decilo primero.
