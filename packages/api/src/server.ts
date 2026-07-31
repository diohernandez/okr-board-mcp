// =============================================================================
// API HTTP — superficie de lectura sobre core (F1)
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
// =============================================================================

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import {
  GitSpecStore, collectValues, NotFoundError, AuthzError, ConcurrencyError, ValidationFailed,
  type KrValue,
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

async function main() {
  const ROOT = await repoRoot();
  const store = new GitSpecStore({ repoDir: ROOT, committer: { name: "okr-board-api", email: "api@bidcom.local" } });
  const resolver: MetricResolver = new SnapshotMetricResolver(
    new FileMetricValueSnapshotLoader(join(ROOT, "data", "metric-values-snapshot.json")));

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }
    if (req.method !== "GET") { sendJson(res, 405, { error: "method not allowed" }); return; }

    const url = new URL(req.url ?? "/", "http://localhost");
    const versionMatch = url.pathname.match(/^\/api\/boards\/([^/]+)\/version$/);
    const boardMatch = url.pathname.match(/^\/api\/boards\/([^/]+)$/);

    try {
      if (versionMatch) {
        const { version } = await store.readHead(versionMatch[1]);
        sendJson(res, 200, { version });
        return;
      }
      if (boardMatch) {
        const { spec, version } = await store.readHead(boardMatch[1]);

        // resolved: mismo path scheme que collectValues() ya usa para validar
        // existencia de métrica en el pipeline de escritura — sin inventar una
        // segunda convención de claves. Solo entradas mode:"metric" (las
        // literales ya viajan completas adentro de `spec`).
        const resolved: Record<string, number | null> = {};
        const metricEntries = collectValues(spec).filter(e => e.value.mode === "metric");
        await Promise.all(metricEntries.map(async e => {
          const mv = e.value as Extract<KrValue, { mode: "metric" }>;
          const { value } = await resolver.resolve(mv.metric, mv.filter);
          resolved[e.path] = value;
        }));

        sendJson(res, 200, { spec, resolved, version });
        return;
      }
      sendJson(res, 404, { error: "ruta no encontrada" });
    } catch (e) {
      sendJson(res, statusFor(e), bodyFor(e));
    }
  });

  server.listen(PORT, () => {
    console.log(`okr-board-api: escuchando en http://localhost:${PORT} (repo=${ROOT})`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
