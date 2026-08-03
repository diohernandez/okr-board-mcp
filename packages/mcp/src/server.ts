// =============================================================================
// MCP okr-board — servidor stdio (M4)
//
// Transporte stdio para consumo local desde Claude Desktop/Code (§3 M4: sin HTTP
// ni auth de red todavía). Este archivo es puro wiring: NO conoce reglas de
// negocio — cablea las 18 tools de contracts/okr-board-mcp.tools.json al pipeline
// compartido (runWrite / runDryRun / runValidate). Cualquier regla nueva va en
// pipeline.ts, no acá.
//
// El principal sale de la config local (env var), tal como pide §3 M4. La
// versión final lo reemplaza por el principal resuelto vía OIDC — el pipeline
// no se entera, porque solo recibe un string.
// =============================================================================

import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema, CallToolRequestSchema,
  type CallToolResult, type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import toolsContract from "../contracts/okr-board-mcp.tools.json";
import {
  GitSpecStore, CachedMetricCatalog, FileMetricSnapshotLoader,
  runWrite, runDryRun, runValidate,
  AuthzError, ConcurrencyError, ValidationFailed, NotFoundError,
  type Change, type PipelineDeps,
} from "core";

const execFileAsync = promisify(execFile);
const PRINCIPAL = process.env.OKR_MCP_PRINCIPAL ?? "@dionisio";

// El MCP sigue sin escribirle nada al API en el sentido de M1-M7 (el pipeline de
// escritura solo conoce GitSpecStore) — esto es un puente aparte, best-effort, para
// que un dry_run se pueda ver en el renderer real (apps/frontend) sin commitear.
// Si el API local no está corriendo, el dry_run igual funciona: solo no hay preview
// navegable, ver pushPreview().
const API_BASE = process.env.OKR_API_BASE ?? "http://localhost:8788";
const FRONTEND_BASE = process.env.OKR_FRONTEND_BASE ?? "http://localhost:8789";

// La raíz del repo se resuelve con git en vez de contar "../.." a mano: mover este
// archivo entre paquetes (packages/mcp/dist/src/... vs. el dist/src/... de antes)
// cambia cuántos niveles hacen falta, y un conteo equivocado no tira error — puede
// escribir en un lugar levemente distinto del que lee, en silencio (ver plan de
// monorepo, sección de riesgos).
//
// El comando git corre con cwd=__dirname (la carpeta real del archivo compilado en
// disco), NO con el cwd heredado del proceso: un launcher externo (Claude Desktop)
// puede spawnear el proceso con cwd="/" sin exponer forma de configurarlo, y
// "git rev-parse" resuelto contra ese cwd fallaría (o, peor, resolvería el repo
// equivocado si "/" fuera casualmente un repo). __dirname es estable sin importar
// quién lance el proceso ni desde dónde.
async function resolveRepoRoot(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: __dirname });
  return stdout.trim();
}

let ROOT: string;
let deps: PipelineDeps;

// ----------------------------------------------------------------------------
// Validación de argumentos: ajv contra el inputSchema publicado de cada tool.
// El contrato (contracts/okr-board-mcp.tools.json) es la fuente de verdad — no
// se re-declaran los schemas acá.
// ----------------------------------------------------------------------------
const tools = toolsContract.tools as unknown as Tool[];
const toolsByName = new Map(tools.map(t => [t.name, t]));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validators = new Map(tools.map(t => [t.name, ajv.compile(t.inputSchema)]));

function jsonResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}
function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
function describeError(e: unknown): string {
  if (e instanceof AuthzError) return `no autorizado: ${e.message}`;
  if (e instanceof ConcurrencyError) return `conflicto de concurrencia (base_version desactualizada): ${e.message}`;
  if (e instanceof ValidationFailed)
    return `validación fallida:\n${e.issues.map(i => `- [${i.code}] ${i.path}: ${i.message}`).join("\n")}`;
  if (e instanceof NotFoundError) return `no encontrado: ${e.message}`;
  return `error inesperado: ${e instanceof Error ? e.message : String(e)}`;
}

// Publica el spec de un dry_run en el slot de preview efímero del API (nunca a
// git) para que apps/frontend lo pueda renderizar con el renderer real. Best-effort
// a propósito: si el API local no está levantado, el dry_run no debe fallar por
// eso — el JSON del resultado ya es útil por sí solo, como antes de esto existir.
async function pushPreview(docId: string, spec: unknown): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/api/boards/${docId}/preview`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec }),
    });
    return res.ok ? `${FRONTEND_BASE}/?preview=1` : null;
  } catch {
    return null;
  }
}
// Limpia el preview tras un commit real: si quedaba una hipótesis vieja sin
// confirmar para este doc, no tiene sentido que siga apareciendo como si fuera
// la vista previa de un cambio distinto ya commiteado. Best-effort, igual que el push.
async function clearPreview(docId: string): Promise<void> {
  try { await fetch(`${API_BASE}/api/boards/${docId}/preview`, { method: "DELETE" }); } catch { /* noop */ }
}

// Las 9 tools de escritura comparten la misma forma: aplican un Change contra
// runWrite, salvo que dry_run=true (M7), en cuyo caso corren la validación
// completa y devuelven el spec resultante SIN commitear. Si además el API local
// está corriendo, dry_run publica una preview real navegable (ver pushPreview).
async function handleWrite(docId: string, baseVersion: string, change: Change, dryRun: boolean): Promise<CallToolResult> {
  if (dryRun) {
    const { spec, valid, errors } = await runDryRun(deps, PRINCIPAL, docId, baseVersion, change);
    const preview_url = valid ? await pushPreview(docId, spec) : null;
    return jsonResult({ valid, errors, spec, preview_url });
  }
  const { version } = await runWrite(deps, PRINCIPAL, docId, baseVersion, change);
  await clearPreview(docId);
  return jsonResult({ version });
}

async function dispatch(name: string, args: Record<string, any>): Promise<CallToolResult> {
  switch (name) {
    case "get_board": {
      const { spec, version } = await deps.store.readHead(args.doc_id);
      return jsonResult({ spec, version });
    }
    case "validate_board": {
      const result = await runValidate(deps, args.doc_id);
      return jsonResult(result);
    }
    case "upsert_roca":
      return handleWrite(args.doc_id, args.base_version, { op: "upsert_roca", roca: args.roca }, !!args.dry_run);
    case "set_kr_value":
      return handleWrite(args.doc_id, args.base_version,
        { op: "set_kr_value", krId: args.kr_id, value: args.value }, !!args.dry_run);
    case "upsert_kr":
      return handleWrite(args.doc_id, args.base_version, { op: "upsert_kr", kr: args.kr }, !!args.dry_run);
    case "upsert_objetivo":
      return handleWrite(args.doc_id, args.base_version, { op: "upsert_objetivo", objetivo: args.objetivo }, !!args.dry_run);
    case "upsert_pilar":
      return handleWrite(args.doc_id, args.base_version, { op: "upsert_pilar", pilar: args.pilar }, !!args.dry_run);
    case "upsert_negocio":
      return handleWrite(args.doc_id, args.base_version, { op: "upsert_negocio", negocio: args.negocio }, !!args.dry_run);
    case "upsert_plataforma":
      return handleWrite(args.doc_id, args.base_version, { op: "upsert_plataforma", plataforma: args.plataforma }, !!args.dry_run);
    case "upsert_kpi":
      return handleWrite(args.doc_id, args.base_version, { op: "upsert_kpi", kpi: args.kpi }, !!args.dry_run);
    case "set_kpi_value":
      return handleWrite(args.doc_id, args.base_version,
        { op: "set_kpi_value", kpiId: args.kpi_id, value: args.value }, !!args.dry_run);
    case "upsert_iniciativa":
      return handleWrite(args.doc_id, args.base_version,
        { op: "upsert_iniciativa", iniciativa: args.iniciativa }, !!args.dry_run);
    case "upsert_hito":
      return handleWrite(args.doc_id, args.base_version,
        { op: "upsert_hito", iniciativaId: args.iniciativa_id, index: args.index, hito: args.hito }, !!args.dry_run);
    case "remove_hito":
      return handleWrite(args.doc_id, args.base_version,
        { op: "remove_hito", iniciativaId: args.iniciativa_id, index: args.index }, !!args.dry_run);
    case "upsert_scope_q":
      return handleWrite(args.doc_id, args.base_version,
        { op: "upsert_scope_q", iniciativaId: args.iniciativa_id, index: args.index, scope: args.scope }, !!args.dry_run);
    case "remove_scope_q":
      return handleWrite(args.doc_id, args.base_version,
        { op: "remove_scope_q", iniciativaId: args.iniciativa_id, index: args.index }, !!args.dry_run);
    case "upsert_onepager_item":
      return handleWrite(args.doc_id, args.base_version, { op: "upsert_onepager_item", item: args.item }, !!args.dry_run);
    case "remove_entity":
      return handleWrite(args.doc_id, args.base_version,
        { op: "remove_entity", entityType: args.entity_type, id: args.id, cascade: !!args.cascade }, !!args.dry_run);
    default:
      throw new Error(`tool desconocida: ${name}`);
  }
}

async function main() {
  ROOT = await resolveRepoRoot();
  deps = {
    store: new GitSpecStore({ repoDir: ROOT, committer: { name: "okr-board-mcp", email: "mcp@bidcom.local" } }),
    catalog: new CachedMetricCatalog(new FileMetricSnapshotLoader(join(ROOT, "data", "metric-catalog.json"))),
  };

  const server = new Server(
    { name: "okr-board-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    if (!toolsByName.has(name)) return errorResult(`tool desconocida: ${name}`);
    const validate = validators.get(name)!;
    if (!validate(args)) {
      const details = (validate.errors ?? []).map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
      return errorResult(`argumentos inválidos para ${name}: ${details}`);
    }

    try {
      return await dispatch(name, args);
    } catch (e) {
      return errorResult(describeError(e));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`okr-board-mcp: servidor MCP corriendo por stdio (principal=${PRINCIPAL}, repo=${ROOT})`);
}

main().catch(e => { console.error(e); process.exit(1); });
