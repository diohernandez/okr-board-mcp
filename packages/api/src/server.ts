// =============================================================================
// API HTTP — superficie de lectura (F1) + preview efímera + escritura (F4)
//
// Adaptador fino, igual que el MCP: NO reimplementa validación ni reglas de
// negocio. La lectura usa SpecStore.readHead() directo; la escritura (F4) pasa
// por el MISMO runWrite/runDryRun que usa el MCP, con su propio PipelineDeps
// (store + catalog) — dos procesos distintos, cada uno con su propia instancia,
// coordinados por el lock multi-proceso de GitSpecStore (ver core/git-store.ts).
//
// La resolución de métricas es 100% acá (server-side): el browser nunca ve un
// filtro ni ejecuta una query, solo recibe el mapa `resolved` ya armado.
//
// /api/boards/:id/preview (PUT/GET/DELETE) sigue siendo un mecanismo DISTINTO de
// F4: es un slot efímero en memoria (Map, se pierde al reiniciar el proceso a
// propósito) para que el MCP -que no tiene superficie HTTP propia- publique un
// dry_run navegable en el frontend. F4 no lo necesita: cuando el dry_run lo pide
// el frontend directo a este mismo servidor, el resultado ya vuelve en la
// respuesta HTTP, sin la vuelta de publicar-y-hacer-poll.
//
// /api/boards/:id/tools/:toolName (POST) SÍ es F4: 1:1 con las tools de escritura
// del MCP (mismo op, mismo shape de args, salvo doc_id que viaja en la URL en vez
// del body). buildChange() duplica a propósito el mapeo nombre->Change de
// packages/mcp/src/server.ts en vez de compartirlo: son dos bordes de transporte
// distintos y el núcleo no debe conocer ninguno de los dos (CLAUDE.md §1.4) — ni
// un borde debería depender del otro. El principal es fijo por env var
// (OKR_API_PRINCIPAL), igual patrón que OKR_MCP_PRINCIPAL: sin login todavía, así
// que técnicamente sigue siendo un solo actor de escritura por proceso, no un
// principal por usuario real — aceptado como límite conocido del MVP mientras
// haya un solo operador probando esto (ver CLAUDE.md §8.1).
// =============================================================================

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import {
  GitSpecStore, CachedMetricCatalog, FileMetricSnapshotLoader, collectValues, runWrite, runDryRun,
  NotFoundError, AuthzError, ConcurrencyError, ValidationFailed,
  type Change, type KrValue, type OkrBoardSpec, type SpecStore, type MetricCatalog,
} from "core";
import { SnapshotMetricResolver, FileMetricValueSnapshotLoader, type MetricResolver } from "./metric-resolver";

const execFileAsync = promisify(execFile);
async function repoRoot(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"]);
  return stdout.trim();
}

const PORT = Number(process.env.PORT ?? 8788);
const PRINCIPAL = process.env.OKR_API_PRINCIPAL ?? "@dionisio";

// Antes de F4 solo NotFoundError era alcanzable (F1 es de solo lectura: readHead
// nunca tira Authz/Concurrency/Validation). F4 hace alcanzables las otras tres —
// mismo mapeo 1:1 que ya usa el MCP, no se reimplementa distinto acá.
function statusFor(e: unknown): number {
  if (e instanceof AuthzError) return 401;
  if (e instanceof ConcurrencyError) return 409;
  if (e instanceof ValidationFailed) return 422;
  if (e instanceof NotFoundError) return 404;
  return 500;
}
function bodyFor(e: unknown): Record<string, unknown> {
  if (e instanceof ValidationFailed) return { error: "validation_failed", issues: e.issues };
  return { error: e instanceof Error ? e.message : String(e) };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*", // MVP local, sin auth de red — ajustar cuando llegue OIDC
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

// Separado de main() para poder testear el ruteo/HTTP real (server.listen(0) +
// fetch) sin pasar por git ni por el MetricResolver real — mismo espíritu que
// SpecStore/MetricResolver como puertos: acá el puerto es "cualquier cosa con la
// forma de SpecStore/MetricResolver", así el test le pasa fakes.
// Tools de escritura del contrato del MCP (packages/mcp/contracts/okr-board-mcp.tools.json)
// que tienen equivalente 1:1 acá. get_board/validate_board quedan afuera: F1 ya los
// cubre con GET /api/boards/:id y no hace falta una tool aparte para eso.
const WRITE_TOOLS = new Set([
  "upsert_roca", "set_kr_value", "upsert_kr", "upsert_objetivo",
  "upsert_pilar", "upsert_negocio", "upsert_plataforma",
  "upsert_kpi", "set_kpi_value", "upsert_iniciativa",
  "upsert_hito", "remove_hito", "upsert_scope_q", "remove_scope_q",
  "upsert_onepager_item", "remove_entity",
]);

// Mapea (toolName, args-ya-parseados-del-body) -> Change. Duplica a propósito el
// switch de packages/mcp/src/server.ts::dispatch() — ver comentario de archivo.
function buildChange(name: string, args: Record<string, any>): Change {
  switch (name) {
    case "upsert_roca": return { op: "upsert_roca", roca: args.roca };
    case "set_kr_value": return { op: "set_kr_value", krId: args.kr_id, value: args.value };
    case "upsert_kr": return { op: "upsert_kr", kr: args.kr };
    case "upsert_objetivo": return { op: "upsert_objetivo", objetivo: args.objetivo };
    case "upsert_pilar": return { op: "upsert_pilar", pilar: args.pilar };
    case "upsert_negocio": return { op: "upsert_negocio", negocio: args.negocio };
    case "upsert_plataforma": return { op: "upsert_plataforma", plataforma: args.plataforma };
    case "upsert_kpi": return { op: "upsert_kpi", kpi: args.kpi };
    case "set_kpi_value": return { op: "set_kpi_value", kpiId: args.kpi_id, value: args.value };
    case "upsert_iniciativa": return { op: "upsert_iniciativa", iniciativa: args.iniciativa };
    case "upsert_hito":
      return { op: "upsert_hito", iniciativaId: args.iniciativa_id, index: args.index, hito: args.hito };
    case "remove_hito": return { op: "remove_hito", iniciativaId: args.iniciativa_id, index: args.index };
    case "upsert_scope_q":
      return { op: "upsert_scope_q", iniciativaId: args.iniciativa_id, index: args.index, scope: args.scope };
    case "remove_scope_q": return { op: "remove_scope_q", iniciativaId: args.iniciativa_id, index: args.index };
    case "upsert_onepager_item": return { op: "upsert_onepager_item", item: args.item };
    case "remove_entity":
      return { op: "remove_entity", entityType: args.entity_type, id: args.id, cascade: !!args.cascade };
    default: throw new Error(`tool desconocida: ${name}`);
  }
}

export function createRequestHandler(
  deps: { store: SpecStore; resolver: MetricResolver; catalog: MetricCatalog; principal: string },
) {
  const { store, resolver, catalog, principal } = deps;

  // resolved: mismo path scheme que collectValues() ya usa para validar existencia
  // de métrica en el pipeline de escritura — sin inventar una segunda convención de
  // claves. Solo entradas mode:"metric" (las literales ya viajan completas en `spec`).
  // Compartido entre el board real y el preview: ambos son "un spec, resolvé sus
  // métricas", la única diferencia es de dónde sale el spec (git vs. el Map de abajo).
  async function resolveMetrics(spec: OkrBoardSpec): Promise<Record<string, number | null>> {
    const resolved: Record<string, number | null> = {};
    const metricEntries = collectValues(spec).filter(e => e.value.mode === "metric");
    await Promise.all(metricEntries.map(async e => {
      const mv = e.value as Extract<KrValue, { mode: "metric" }>;
      const { value } = await resolver.resolve(mv.metric, mv.filter);
      resolved[e.path] = value;
    }));
    return resolved;
  }

  // Slot de preview efímero: en memoria, por docId, se pierde al reiniciar el
  // proceso a propósito. Nunca se persiste a git ni pasa por runWrite/runDryRun acá
  // (esa validación ya la corrió el MCP antes de publicar) — ver comentario de
  // archivo. Un solo slot por doc: la preview más reciente reemplaza a la anterior.
  const previewSpecs = new Map<string, OkrBoardSpec>();

  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const versionMatch = url.pathname.match(/^\/api\/boards\/([^/]+)\/version$/);
    const previewMatch = url.pathname.match(/^\/api\/boards\/([^/]+)\/preview$/);
    const toolMatch = url.pathname.match(/^\/api\/boards\/([^/]+)\/tools\/([^/]+)$/);
    const boardMatch = url.pathname.match(/^\/api\/boards\/([^/]+)$/);

    try {
      if (previewMatch) {
        const docId = previewMatch[1];
        if (req.method === "PUT") {
          const body = JSON.parse(await readBody(req) || "{}");
          if (!body?.spec) { sendJson(res, 400, { error: "falta 'spec' en el body" }); return; }
          previewSpecs.set(docId, body.spec as OkrBoardSpec);
          sendJson(res, 200, { resolved: await resolveMetrics(body.spec) });
          return;
        }
        if (req.method === "GET") {
          const spec = previewSpecs.get(docId);
          if (!spec) { sendJson(res, 404, { error: "no hay preview activo para este doc" }); return; }
          sendJson(res, 200, { spec, resolved: await resolveMetrics(spec) });
          return;
        }
        if (req.method === "DELETE") {
          previewSpecs.delete(docId);
          res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
          res.end();
          return;
        }
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }

      if (toolMatch) {
        const [, docId, toolName] = toolMatch;
        if (req.method !== "POST") { sendJson(res, 405, { error: "method not allowed" }); return; }
        if (!WRITE_TOOLS.has(toolName)) { sendJson(res, 404, { error: `tool desconocida: ${toolName}` }); return; }
        const body = JSON.parse(await readBody(req) || "{}");
        if (typeof body.base_version !== "string") { sendJson(res, 400, { error: "falta 'base_version'" }); return; }
        const change = buildChange(toolName, body);
        const deps = { store, catalog };
        if (body.dry_run) {
          const { spec, valid, errors } = await runDryRun(deps, principal, docId, body.base_version, change);
          sendJson(res, 200, { spec, valid, errors, resolved: valid ? await resolveMetrics(spec) : undefined });
          return;
        }
        const { version } = await runWrite(deps, principal, docId, body.base_version, change);
        previewSpecs.delete(docId); // igual que clearPreview() del MCP: un write real invalida cualquier preview vieja
        sendJson(res, 200, { version });
        return;
      }

      if (req.method !== "GET") { sendJson(res, 405, { error: "method not allowed" }); return; }

      if (versionMatch) {
        const { version } = await store.readHead(versionMatch[1]);
        sendJson(res, 200, { version });
        return;
      }
      if (boardMatch) {
        const { spec, version } = await store.readHead(boardMatch[1]);
        sendJson(res, 200, { spec, resolved: await resolveMetrics(spec), version });
        return;
      }
      sendJson(res, 404, { error: "ruta no encontrada" });
    } catch (e) {
      sendJson(res, statusFor(e), bodyFor(e));
    }
  };
}

async function main() {
  const ROOT = await repoRoot();
  const store = new GitSpecStore({ repoDir: ROOT, committer: { name: "okr-board-api", email: "api@bidcom.local" } });
  const resolver: MetricResolver = new SnapshotMetricResolver(
    new FileMetricValueSnapshotLoader(join(ROOT, "data", "metric-values-snapshot.json")));
  const catalog: MetricCatalog = new CachedMetricCatalog(
    new FileMetricSnapshotLoader(join(ROOT, "data", "metric-catalog.json")));

  const server = createServer(createRequestHandler({ store, resolver, catalog, principal: PRINCIPAL }));
  server.listen(PORT, () => {
    console.log(`okr-board-api: escuchando en http://localhost:${PORT} (repo=${ROOT}, principal=${PRINCIPAL})`);
  });
}

// Guard de entrypoint: createRequestHandler se importa desde tests (server.listen(0)
// + fetch, ver test/preview-endpoint.test.ts) sin querer levantar el server real en
// el PORT de verdad — solo corre main() cuando este archivo es el que se ejecutó
// directamente (`node dist/src/server.js`), no cuando otro módulo lo importa.
if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
