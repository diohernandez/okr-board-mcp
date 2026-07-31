// =============================================================================
// bootstrap (M5) — extrae defaultData del HTML actual y genera el spec.json inicial
//
// No parsea/edita el HTML (eso violaría §1.2): solo LEE el literal `defaultData`
// para fundar el primer spec.json. A partir de acá, todo cambio pasa por el MCP.
//
// defaultData no es JSON estricto (claves sin comillas, comentarios, algunas
// entradas con comillas simples): se extrae el literal con brace-matching (respeta
// strings/escapes/comentarios) y se evalúa en un contexto vm aislado — no es un
// eval de datos ajenos, es el propio HTML versionado de este repo.
//
// Transforma la forma legacy (plana, con flags com/dg/okr2026 y actual/prevActual
// sueltos) a la forma del schema (value:{mode,actual,prev}, boards:[...]). rocas,
// pilares, negocios, plataformas y objetivos ya calzan con el schema tal cual están.
//
// Exclusión deliberada: los KPIs de pilar que referencian negocios dados de baja
// (ver mergeWithDefaults() en el HTML: "Regional y Bidcom Service se discontinuaron")
// quedan afuera — están vacíos (actual y target null) y su FK ya no resuelve a nada.
//
// Valida contra el schema + FKs + catálogo de métricas (mismo validateSpec del
// pipeline) ANTES de commitear. Si no valida, no escribe nada.
// =============================================================================

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import {
  validateSpec, GitSpecStore, CachedMetricCatalog, FileMetricSnapshotLoader,
  type OkrBoardSpec, type Kr, type Kpi, type Iniciativa, type Hito, type OnePagerItem, type KrValue,
} from "core";

const ROOT = join(__dirname, "..", "..");
const HTML_PATH = join(ROOT, "renderer", "despliegue_estrategico.html");
const CATALOG_PATH = join(ROOT, "data", "metric-catalog.json");
const DOC_ID = "despliegue-estrategico-2026";
const DROPPED_NEGOCIO_IDS = new Set(["regional", "service"]); // discontinuados, ver mergeWithDefaults() en el HTML

// ---- extracción segura del literal defaultData (brace-matching, no regex frágil) ----
function matchBrace(text: string, openIdx: number): number {
  let depth = 0;
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    const prev = text[i - 1];
    if (inLineComment) { if (c === "\n") inLineComment = false; continue; }
    if (inBlockComment) { if (prev === "*" && c === "/") inBlockComment = false; continue; }
    if (inString) {
      if (c === "\\") { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") { inLineComment = true; continue; }
    if (c === "/" && text[i + 1] === "*") { inBlockComment = true; continue; }
    if (c === '"' || c === "'" || c === "`") { inString = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
  }
  throw new Error("bootstrap: no se encontró el cierre de 'defaultData' (llaves desbalanceadas)");
}

function extractDefaultData(html: string): any {
  const marker = "const defaultData = {";
  const start = html.indexOf(marker);
  if (start === -1) throw new Error("bootstrap: no se encontró 'const defaultData = {' en el HTML");
  const braceStart = start + marker.length - 1;
  const braceEnd = matchBrace(html, braceStart);
  const literal = html.slice(braceStart, braceEnd + 1);
  const sandbox: { result?: unknown } = {};
  createContext(sandbox);
  runInContext(`result = (${literal})`, sandbox, { timeout: 5000 });
  return sandbox.result;
}

// ---- transformación legacy -> schema ----
function toLiteralValue(actual: unknown, prev?: unknown): KrValue {
  const value: any = { mode: "literal", actual: (actual as number) ?? null };
  if (prev !== undefined) value.prev = prev;
  return value;
}

function toBoards(raw: any): ("comite" | "direccion_general" | "okr2026")[] {
  const boards: ("comite" | "direccion_general" | "okr2026")[] = [];
  if (raw.com) boards.push("comite");
  if (raw.dg) boards.push("direccion_general");
  if (raw.okr2026) boards.push("okr2026");
  return boards;
}

function transformKr(raw: any): Kr {
  return {
    id: raw.id, objId: raw.objId, desc: raw.desc, sentido: raw.sentido, unidad: raw.unidad,
    target: raw.target ?? null,
    value: toLiteralValue(raw.actual, raw.prevActual),
    boards: toBoards(raw),
  };
}

function transformKpi(raw: any): Kpi {
  return {
    id: raw.id, pilarId: raw.pilarId, negocioId: raw.negocioId, nombre: raw.nombre,
    sentido: raw.sentido, unidad: raw.unidad, target: raw.target ?? null,
    value: toLiteralValue(raw.actual),
  };
}

function transformHito(raw: any): Hito {
  return {
    texto: raw.texto, sentido: raw.sentido, unidad: raw.unidad ?? "",
    target: raw.target ?? null, value: toLiteralValue(raw.actual),
  };
}

function transformIniciativa(raw: any): Iniciativa {
  return {
    id: raw.id, prioridad: raw.prioridad, nombre: raw.nombre,
    sponsor: raw.sponsor ?? "", owner: raw.owner ?? "", equipo: raw.equipo ?? "",
    pilarId: raw.pilarId ?? null, scopeIniciativa: raw.scopeIniciativa ?? "",
    hitos: (raw.krs ?? []).map(transformHito),
    scopesQ: raw.scopesQ ?? [],
    riesgos: raw.riesgos ?? "", riesgoSemaforo: raw.riesgoSemaforo ?? null,
    rocaIds: raw.rocaIds ?? [],
  };
}

function transformOnePagerItem(raw: any): OnePagerItem {
  const { actual, target, children, com, dg, okr2026, ...rest } = raw;
  return { ...rest, target: target ?? null, value: toLiteralValue(actual), children: children ?? [] };
}

async function buildSpec(raw: any): Promise<OkrBoardSpec> {
  const rawKpis = raw.kpis ?? [];
  const kpisKept = rawKpis.filter((k: any) => !DROPPED_NEGOCIO_IDS.has(k.negocioId));
  const droppedCount = rawKpis.length - kpisKept.length;
  if (droppedCount > 0) {
    console.log(`bootstrap: excluidos ${droppedCount} kpi(s) que referencian un negocio dado de baja (${
      [...DROPPED_NEGOCIO_IDS].join("/")})`);
  }

  return {
    doc: {
      id: DOC_ID, type: "okr-board", title: "Despliegue Estratégico 2026", version: 1,
      updated_at: new Date().toISOString(), access: "domain",
      acl: [{ principal: "@dionisio", role: "owner" }],
    },
    pilares: raw.pilares, negocios: raw.negocios, plataformas: raw.plataformas, objetivos: raw.objetivos,
    krs: raw.krs.map(transformKr),
    rocas: raw.rocas,
    kpis: kpisKept.map(transformKpi),
    iniciativas: (raw.iniciativas ?? []).map(transformIniciativa),
    onePager: (raw.onePager ?? []).map(transformOnePagerItem),
  };
}

async function main() {
  const html = await readFile(HTML_PATH, "utf8");
  const raw = extractDefaultData(html);
  const spec = await buildSpec(raw);

  const catalog = new CachedMetricCatalog(new FileMetricSnapshotLoader(CATALOG_PATH));
  const issues = await validateSpec(spec, catalog);
  if (issues.length) {
    console.error(`bootstrap: el spec generado NO valida (${issues.length} problema(s)) — no se escribe nada:`);
    issues.forEach(i => console.error(`  [${i.code}] ${i.path}: ${i.message}`));
    process.exit(1);
  }
  console.log(`bootstrap: spec válido — ${spec.pilares.length} pilares, ${spec.negocios.length} negocios, ` +
    `${spec.plataformas.length} plataformas, ${spec.objetivos.length} objetivos, ${spec.krs.length} krs, ` +
    `${spec.rocas.length} rocas, ${spec.kpis.length} kpis, ${spec.iniciativas.length} iniciativas, ` +
    `${spec.onePager.length} filas onePager.`);

  const store = new GitSpecStore({ repoDir: ROOT, committer: { name: "okr-board-mcp bootstrap", email: "mcp@bidcom.local" } });
  const version = await store.init(spec.doc.id, spec,
    `bootstrap: spec inicial extraído de defaultData (${spec.krs.length} krs, ${spec.rocas.length} rocas, ` +
    `${spec.kpis.length} kpis, ${spec.iniciativas.length} iniciativas, ${spec.onePager.length} onePager)`);
  console.log(`bootstrap: data/${spec.doc.id}.json commiteado en git. version=${version}`);
}

main().catch(e => { console.error(e); process.exit(1); });
