// =============================================================================
// MCP okr-board — servidor stdio (M4)
//
// Transporte stdio para consumo local desde Claude Desktop/Code (§3 M4: sin HTTP
// ni auth de red todavía). Este archivo es puro wiring: NO conoce reglas de
// negocio — cablea las 11 tools de contracts/okr-board-mcp.tools.json al pipeline
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

// La raíz del repo se resuelve con git en vez de contar "../.." a mano: mover este
// archivo entre paquetes (packages/mcp/dist/src/... vs. el dist/src/... de antes)
// cambia cuántos niveles hacen falta, y un conteo equivocado no tira error — puede
// escribir en un lugar levemente distinto del que lee, en silencio (ver plan de
// monorepo, sección de riesgos).
async function resolveRepoRoot(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"]);
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

// Las 9 tools de escritura comparten la misma forma: aplican un Change contra
// runWrite, salvo que dry_run=true (M7), en cuyo caso corren la validación
// completa y devuelven el spec resultante SIN commitear.
async function handleWrite(docId: string, baseVersion: string, change: Change, dryRun: boolean): Promise<CallToolResult> {
  if (dryRun) {
    const { spec, valid, errors } = await runDryRun(deps, PRINCIPAL, docId, baseVersion, change);
    return jsonResult({ valid, errors, spec });
  }
  const { version } = await runWrite(deps, PRINCIPAL, docId, baseVersion, change);
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
    case "upsert_kpi":
      return handleWrite(args.doc_id, args.base_version, { op: "upsert_kpi", kpi: args.kpi }, !!args.dry_run);
    case "set_kpi_value":
      return handleWrite(args.doc_id, args.base_version,
        { op: "set_kpi_value", kpiId: args.kpi_id, value: args.value }, !!args.dry_run);
    case "upsert_iniciativa":
      return handleWrite(args.doc_id, args.base_version,
        { op: "upsert_iniciativa", iniciativa: args.iniciativa }, !!args.dry_run);
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
