// =============================================================================
// API HTTP — superficie de lectura sobre core (F1) + preview efímera (ver abajo)
//
// Adaptador fino, igual que el MCP: NO reimplementa validación ni reglas de
// negocio. Para lectura, esto alcanza con SpecStore.readHead() directo (no hace
// falta pasar por runWrite/PipelineDeps porque acá no se escribe nada todavía —
// eso es F4). Cuando F4 sume escritura, sí va a necesitar PipelineDeps completo
// (store + MetricCatalog) para llamar a runWrite/runDryRun, igual que server.ts
// del MCP.
//
// La resolución de métricas es 100% acá (server-side): el browser nunca ve un
// filtro ni ejecuta una query, solo recibe el mapa `resolved` ya armado.
//
// /api/boards/:id/preview (PUT/GET/DELETE) NO es F4: no escribe nada a git, no
// pasa por runWrite. Es un slot efímero en memoria (Map, se pierde al reiniciar
// el proceso a propósito) donde el MCP publica el spec que ya validó con un
// dry_run, para que el frontend real lo pueda renderizar con el mismo adaptador
// y el mismo MetricResolver que usa el board de verdad — sin commitear nada.
// =============================================================================

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import {
  GitSpecStore, collectValues, NotFoundError, AuthzError, ConcurrencyError, ValidationFailed,
  type KrValue, type OkrBoardSpec, type SpecStore,
} from "core";
import { SnapshotMetricResolver, FileMetricValueSnapshotLoader, type MetricResolver } from "./metric-resolver";

const execFileAsync = promisify(execFile);
async function repoRoot(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"]);
  return stdout.trim();
}

const PORT = Number(process.env.PORT ?? 8788);

// Hoy solo NotFoundError es alcanzable (F1 es de solo lectura: readHead nunca
// tira Authz/Concurrency/Validation, eso sale de runWrite/runDryRun). Se mapean
// las cuatro igual porque F4 (escritura desde el frontend) las va a necesitar,
// y es el mismo mapeo 1:1 que ya usa el MCP — no se reimplementa distinto acá.
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
export function createRequestHandler(deps: { store: SpecStore; resolver: MetricResolver }) {
  const { store, resolver } = deps;

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
        "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const versionMatch = url.pathname.match(/^\/api\/boards\/([^/]+)\/version$/);
    const previewMatch = url.pathname.match(/^\/api\/boards\/([^/]+)\/preview$/);
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

  const server = createServer(createRequestHandler({ store, resolver }));
  server.listen(PORT, () => {
    console.log(`okr-board-api: escuchando en http://localhost:${PORT} (repo=${ROOT})`);
  });
}

// Guard de entrypoint: createRequestHandler se importa desde tests (server.listen(0)
// + fetch, ver test/preview-endpoint.test.ts) sin querer levantar el server real en
// el PORT de verdad — solo corre main() cuando este archivo es el que se ejecutó
// directamente (`node dist/src/server.js`), no cuando otro módulo lo importa.
if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
