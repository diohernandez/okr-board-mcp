// =============================================================================
// MCP okr-board — Pipeline de escritura (implementación de referencia)
//
// Invariante: TODA escritura pasa por runWrite() (o runDryRun() para previsualizar),
// en este orden:
//   1. concurrencia optimista (base_version debe ser el HEAD actual)
//   2. authz (el principal debe ser owner/editor en el acl del doc)
//   3. aplicar el cambio ACOTADO sobre una copia del spec (funciones puras)
//   4. validar EN CASCADA el spec resultante completo:
//        a. JSON Schema (el contrato)         -> okr-board.schema.json
//        b. integridad referencial (FKs)      -> lo que el schema no puede
//        c. existencia de métrica gobernada   -> contra la capa semántica
//   5. commit a git  (o rechazo SIN commit; el repo queda intacto)
//
// runDryRun() corre 1-4 y devuelve el spec resultante SIN tocar el paso 5 (M7).
//
// Sugerencia de archivos en el repo real:
//   types.ts · errors.ts · ports.ts · appliers.ts · validate.ts · pipeline.ts
// Acá van juntos como referencia única.
// =============================================================================

import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import okrSchema from "../contracts/okr-board.schema.json";

// ----------------------------------------------------------------------------
// 1. Tipos del dominio (derivados de okr-board.schema.json)
// ----------------------------------------------------------------------------
export type KrValue =
  | { mode: "literal"; actual: number | null; prev?: number | null; as_of?: string }
  | { mode: "metric"; metric: string; filter?: Record<string, string> };

export interface Kr {
  id: string; objId: string; desc: string;
  sentido: "mayor" | "menor"; unidad: string; target: number | null;
  value: KrValue; boards?: ("comite" | "direccion_general" | "okr2026")[];
}
export interface Roca {
  id: string; nombre: string; detalle: string; area: string;
  equipo: string | null; trimestre: string | null;
  estado: "no_iniciada" | "en_progreso" | "frenada" | "completada";
  columna: string; krIds: string[]; pilarIds: string[];
}
export interface Objetivo { id: string; negocioId: string; nombre: string; texto: string; }
export interface Pilar { id: string; nombre: string; desc: string; okrIds: string[]; }
export interface Negocio { id: string; nombre: string; }
export interface Plataforma { id: string; nombre: string; area: string; }
export interface Acl { principal: string; role: "owner" | "editor" | "viewer"; }

// KPI de salud de negocio: cuelga de un pilar + negocio/plataforma (no de un objetivo).
export interface Kpi {
  id: string; pilarId: string; negocioId: string; nombre: string;
  sentido: "mayor" | "menor"; unidad: string; target: number | null; value: KrValue;
}

// Hito/entregable de una iniciativa. Sin id propio: vive y se reemplaza junto con la iniciativa.
export interface Hito {
  texto: string; sentido: "mayor" | "menor"; unidad: string; target: number | null; value: KrValue;
}
export interface ScopeQ { quarter: string; texto: string; }
export type Semaforo = "verde" | "amarillo" | "rojo" | null;

export interface Iniciativa {
  id: string; prioridad: number; nombre: string; sponsor: string; owner: string; equipo: string;
  pilarId: string | null; scopeIniciativa: string; hitos: Hito[]; scopesQ: ScopeQ[];
  riesgos: string; riesgoSemaforo: Semaforo; rocaIds: string[];
}

// Nodo de desglose recursivo (por canal/marca) dentro de una fila de onePager. Sin id propio.
export interface OnePagerNode { nombre: string; actual: number | null; children?: OnePagerNode[]; }
export interface OnePagerItem {
  id: string; negocioId: string; grupo: string; par?: string; sentido: "mayor" | "menor";
  nombre: string; unidad: string; target: number | null; value: KrValue; children?: OnePagerNode[];
}

export interface OkrBoardSpec {
  doc: {
    id: string; type: "okr-board"; title: string; version: number;
    updated_at: string; access: "domain"; acl: Acl[];
  };
  pilares: Pilar[]; negocios: Negocio[]; plataformas: Plataforma[];
  objetivos: Objetivo[]; krs: Kr[]; rocas: Roca[];
  kpis: Kpi[]; iniciativas: Iniciativa[]; onePager: OnePagerItem[];
}

export type EntityType =
  | "pilar" | "negocio" | "plataforma" | "objetivo" | "kr" | "roca"
  | "kpi" | "iniciativa" | "onepager_item";

// Cambios acotados — uno por tool de escritura. Claude describe la intención;
// el MCP la ejecuta quirúrgicamente. Nunca se reescribe el documento entero.
export type Change =
  | { op: "upsert_roca"; roca: Partial<Roca> & { id: string } }
  | { op: "set_kr_value"; krId: string; value: KrValue }
  | { op: "upsert_kr"; kr: Partial<Omit<Kr, "value">> & { id: string } }
  | { op: "upsert_objetivo"; objetivo: Partial<Objetivo> & { id: string } }
  | { op: "upsert_pilar"; pilar: Partial<Pilar> & { id: string } }
  | { op: "upsert_negocio"; negocio: Partial<Negocio> & { id: string } }
  | { op: "upsert_plataforma"; plataforma: Partial<Plataforma> & { id: string } }
  | { op: "upsert_kpi"; kpi: Partial<Omit<Kpi, "value">> & { id: string } }
  | { op: "set_kpi_value"; kpiId: string; value: KrValue }
  | { op: "upsert_iniciativa"; iniciativa: Partial<Iniciativa> & { id: string } }
  | { op: "upsert_hito"; iniciativaId: string; index?: number; hito: Partial<Hito> }
  | { op: "remove_hito"; iniciativaId: string; index: number }
  | { op: "upsert_scope_q"; iniciativaId: string; index?: number; scope: Partial<ScopeQ> }
  | { op: "remove_scope_q"; iniciativaId: string; index: number }
  | { op: "upsert_onepager_item"; item: Partial<OnePagerItem> & { id: string } }
  | { op: "remove_entity"; entityType: EntityType; id: string; cascade: boolean };

// ----------------------------------------------------------------------------
// 2. Errores tipados (el MCP los mapea: authz -> 401; el resto -> isError)
// ----------------------------------------------------------------------------
export class AuthzError extends Error {}
export class ConcurrencyError extends Error {}
export interface ValidationIssue { code: string; path: string; message: string; }
export class ValidationFailed extends Error {
  constructor(public issues: ValidationIssue[]) { super("validation failed"); }
}
export class NotFoundError extends Error {}

// ----------------------------------------------------------------------------
// 3. Ports (lo que varía y se inyecta). Cambiar git -> Postgres = otra impl de
//    SpecStore, sin tocar el pipeline. MetricCatalog = costura con la capa semántica.
// ----------------------------------------------------------------------------
export interface SpecStore {
  readHead(docId: string): Promise<{ spec: OkrBoardSpec; version: string }>;
  // commit DEBE verificar atómicamente que el HEAD sigue siendo expectedVersion;
  // si cambió, lanza ConcurrencyError. Devuelve el nuevo token de versión.
  commit(docId: string, spec: OkrBoardSpec, message: string, expectedVersion: string): Promise<string>;
}
export interface MetricCatalog {
  // Consulta el catálogo de la capa semántica (Analytics MCP). true si la métrica existe.
  has(metric: string): Promise<boolean>;
}

// ----------------------------------------------------------------------------
// 4. Appliers — funciones PURAS (sin I/O). (spec, change) -> spec nuevo.
// ----------------------------------------------------------------------------
function upsertById<T extends { id: string }>(arr: T[], patch: Partial<T> & { id: string }): T[] {
  const i = arr.findIndex(e => e.id === patch.id);
  if (i === -1) return [...arr, patch as T];          // nuevo: la validación exige completitud
  const merged = { ...arr[i], ...patch };             // existente: merge parcial
  return arr.map((e, j) => (j === i ? merged : e));
}

// Homólogo de upsertById para sub-ítems SIN id propio (hitos, scopesQ): se
// direccionan por posición en vez de por id. index=undefined -> agrega al final
// (nuevo: la validación exige completitud, mismo criterio que upsertById); index
// fuera de rango -> NotFoundError (no ValidationFailed: no es un problema de forma
// del spec, es que la posición pedida no existe).
function upsertAt<T>(arr: T[], index: number | undefined, patch: Partial<T>, label: string): T[] {
  if (index === undefined) return [...arr, patch as T];
  if (index < 0 || index >= arr.length)
    throw new NotFoundError(`${label}: index fuera de rango (${index}), hay ${arr.length}`);
  return arr.map((e, i) => (i === index ? { ...e, ...patch } : e));
}
function removeAt<T>(arr: T[], index: number, label: string): T[] {
  if (index < 0 || index >= arr.length)
    throw new NotFoundError(`${label}: index fuera de rango (${index}), hay ${arr.length}`);
  return arr.filter((_, i) => i !== index);
}
function findIniciativa(spec: OkrBoardSpec, id: string): Iniciativa {
  const ini = spec.iniciativas.find(i => i.id === id);
  if (!ini) throw new NotFoundError(`iniciativa no encontrada: ${id}`);
  return ini;
}

const collectionOf: Record<EntityType, keyof OkrBoardSpec> = {
  pilar: "pilares", negocio: "negocios", plataforma: "plataformas",
  objetivo: "objetivos", kr: "krs", roca: "rocas",
  kpi: "kpis", iniciativa: "iniciativas", onepager_item: "onePager",
};

// Mapa de referencias entrantes: para cada entidad, quién la apunta.
// scalar = FK obligatoria (borrar en cascada = borrar al hijo); array = FK en lista (limpiar
// del array); nullableScalar = FK opcional en un campo escalar (poner en null, no borrar al hijo).
function findReferrers(spec: OkrBoardSpec, type: EntityType, id: string) {
  const scalar: { type: EntityType; id: string }[] = [];
  const array: { type: EntityType; id: string; field: string }[] = [];
  const nullableScalar: { type: EntityType; id: string; field: string }[] = [];

  if (type === "objetivo") {
    spec.krs.filter(k => k.objId === id).forEach(k => scalar.push({ type: "kr", id: k.id }));
    spec.pilares.filter(p => p.okrIds.includes(id)).forEach(p => array.push({ type: "pilar", id: p.id, field: "okrIds" }));
  }
  if (type === "negocio" || type === "plataforma") {
    spec.objetivos.filter(o => o.negocioId === id).forEach(o => scalar.push({ type: "objetivo", id: o.id }));
    spec.kpis.filter(k => k.negocioId === id).forEach(k => scalar.push({ type: "kpi", id: k.id }));
    spec.onePager.filter(p => p.negocioId === id).forEach(p => scalar.push({ type: "onepager_item", id: p.id }));
  }
  if (type === "kr") {
    spec.rocas.filter(r => r.krIds.includes(id)).forEach(r => array.push({ type: "roca", id: r.id, field: "krIds" }));
  }
  if (type === "pilar") {
    spec.rocas.filter(r => r.pilarIds.includes(id)).forEach(r => array.push({ type: "roca", id: r.id, field: "pilarIds" }));
    spec.kpis.filter(k => k.pilarId === id).forEach(k => scalar.push({ type: "kpi", id: k.id }));
    spec.iniciativas.filter(i => i.pilarId === id).forEach(i => nullableScalar.push({ type: "iniciativa", id: i.id, field: "pilarId" }));
  }
  if (type === "roca") {
    spec.iniciativas.filter(i => i.rocaIds.includes(id)).forEach(i => array.push({ type: "iniciativa", id: i.id, field: "rocaIds" }));
  }
  return { scalar, array, nullableScalar };
}

function removeEntity(spec: OkrBoardSpec, type: EntityType, id: string, cascade: boolean): OkrBoardSpec {
  const { scalar, array, nullableScalar } = findReferrers(spec, type, id);
  if ((scalar.length || array.length || nullableScalar.length) && !cascade) {
    const refs = [...scalar, ...array, ...nullableScalar].map(r => `${r.type}:${r.id}`).join(", ");
    throw new ValidationFailed([{
      code: "referential_integrity",
      path: `${type}:${id}`,
      message: `no se puede borrar: referenciado por ${refs}. Usar cascade=true para forzar.`,
    }]);
  }
  let next = spec;
  // 1) limpiar refs en arrays
  for (const a of array) {
    const coll = collectionOf[a.type] as "rocas" | "pilares" | "iniciativas";
    next = {
      ...next,
      [coll]: (next[coll] as any[]).map(e =>
        e.id === a.id ? { ...e, [a.field]: (e[a.field] as string[]).filter(x => x !== id) } : e),
    } as OkrBoardSpec;
  }
  // 2) poner en null los campos escalares opcionales que apuntaban a la entidad borrada
  for (const n of nullableScalar) {
    const coll = collectionOf[n.type] as "iniciativas";
    next = {
      ...next,
      [coll]: (next[coll] as any[]).map(e => (e.id === n.id ? { ...e, [n.field]: null } : e)),
    } as OkrBoardSpec;
  }
  // 3) cascada recursiva sobre hijos con FK escalar obligatoria
  for (const s of scalar) next = removeEntity(next, s.type, s.id, true);
  // 4) quitar la entidad
  const coll = collectionOf[type];
  next = { ...next, [coll]: (next[coll] as any[]).filter(e => e.id !== id) } as OkrBoardSpec;
  return next;
}

export function applyChange(spec: OkrBoardSpec, change: Change): OkrBoardSpec {
  const next: OkrBoardSpec = structuredClone(spec);
  switch (change.op) {
    case "upsert_roca":
      next.rocas = upsertById(next.rocas, change.roca as Partial<Roca> & { id: string });
      return next;
    case "upsert_objetivo":
      next.objetivos = upsertById(next.objetivos, change.objetivo);
      return next;
    case "upsert_pilar":
      next.pilares = upsertById(next.pilares, change.pilar);
      return next;
    case "upsert_negocio":
      next.negocios = upsertById(next.negocios, change.negocio);
      return next;
    case "upsert_plataforma":
      next.plataformas = upsertById(next.plataformas, change.plataforma);
      return next;
    case "upsert_kr":
      // merge de metadata; NO toca value (eso va por set_kr_value)
      next.krs = upsertById(next.krs, change.kr as Partial<Kr> & { id: string });
      return next;
    case "set_kr_value": {
      const kr = next.krs.find(k => k.id === change.krId);
      if (!kr) throw new NotFoundError(`kr no encontrado: ${change.krId}`);
      kr.value = change.value;
      return next;
    }
    case "upsert_kpi":
      next.kpis = upsertById(next.kpis, change.kpi as Partial<Kpi> & { id: string });
      return next;
    case "set_kpi_value": {
      const kpi = next.kpis.find(k => k.id === change.kpiId);
      if (!kpi) throw new NotFoundError(`kpi no encontrado: ${change.kpiId}`);
      kpi.value = change.value;
      return next;
    }
    case "upsert_iniciativa":
      next.iniciativas = upsertById(next.iniciativas, change.iniciativa as Partial<Iniciativa> & { id: string });
      return next;
    case "upsert_hito": {
      const ini = findIniciativa(next, change.iniciativaId);
      ini.hitos = upsertAt(ini.hitos, change.index, change.hito, `iniciativa ${ini.id} hitos`);
      return next;
    }
    case "remove_hito": {
      const ini = findIniciativa(next, change.iniciativaId);
      ini.hitos = removeAt(ini.hitos, change.index, `iniciativa ${ini.id} hitos`);
      return next;
    }
    case "upsert_scope_q": {
      const ini = findIniciativa(next, change.iniciativaId);
      ini.scopesQ = upsertAt(ini.scopesQ, change.index, change.scope, `iniciativa ${ini.id} scopesQ`);
      return next;
    }
    case "remove_scope_q": {
      const ini = findIniciativa(next, change.iniciativaId);
      ini.scopesQ = removeAt(ini.scopesQ, change.index, `iniciativa ${ini.id} scopesQ`);
      return next;
    }
    case "upsert_onepager_item":
      next.onePager = upsertById(next.onePager, change.item as Partial<OnePagerItem> & { id: string });
      return next;
    case "remove_entity":
      return removeEntity(next, change.entityType, change.id, change.cascade);
  }
}

// ----------------------------------------------------------------------------
// 5. Validación en cascada
// ----------------------------------------------------------------------------
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateSchema = ajv.compile(okrSchema as object);

function checkReferentialIntegrity(spec: OkrBoardSpec): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = (arr: { id: string }[]) => new Set(arr.map(e => e.id));
  const objIds = ids(spec.objetivos);
  const krIds = ids(spec.krs);
  const pilarIds = ids(spec.pilares);
  const rocaIds = ids(spec.rocas);
  const unidadIds = new Set([...spec.negocios, ...spec.plataformas].map(e => e.id)); // negocio | plataforma

  const fk = (cond: boolean, path: string, msg: string) =>
    { if (!cond) issues.push({ code: "referential_integrity", path, message: msg }); };

  spec.pilares.forEach(p => p.okrIds.forEach(o =>
    fk(objIds.has(o), `pilares/${p.id}/okrIds`, `okrId inexistente: ${o}`)));
  spec.objetivos.forEach(o =>
    fk(unidadIds.has(o.negocioId), `objetivos/${o.id}/negocioId`, `negocioId/plataformaId inexistente: ${o.negocioId}`));
  spec.krs.forEach(k =>
    fk(objIds.has(k.objId), `krs/${k.id}/objId`, `objId inexistente: ${k.objId}`));
  spec.rocas.forEach(r => {
    r.krIds.forEach(k => fk(krIds.has(k), `rocas/${r.id}/krIds`, `krId inexistente: ${k}`));
    r.pilarIds.forEach(p => fk(pilarIds.has(p), `rocas/${r.id}/pilarIds`, `pilarId inexistente: ${p}`));
  });
  spec.kpis.forEach(k => {
    fk(pilarIds.has(k.pilarId), `kpis/${k.id}/pilarId`, `pilarId inexistente: ${k.pilarId}`);
    fk(unidadIds.has(k.negocioId), `kpis/${k.id}/negocioId`, `negocioId/plataformaId inexistente: ${k.negocioId}`);
  });
  spec.iniciativas.forEach(i => {
    if (i.pilarId !== null) fk(pilarIds.has(i.pilarId), `iniciativas/${i.id}/pilarId`, `pilarId inexistente: ${i.pilarId}`);
    i.rocaIds.forEach(r => fk(rocaIds.has(r), `iniciativas/${i.id}/rocaIds`, `rocaId inexistente: ${r}`));
  });
  spec.onePager.forEach(p =>
    fk(unidadIds.has(p.negocioId), `onePager/${p.id}/negocioId`, `negocioId/plataformaId inexistente: ${p.negocioId}`));
  return issues;
}

// Todos los lugares del spec donde vive un KrValue gobernable (KR, KPI, hito de
// iniciativa, fila de onePager). Los nodos hijos de onePager quedan afuera a propósito:
// son desglose de solo lectura, siempre literal por ahora.
export function collectValues(spec: OkrBoardSpec): { path: string; value: KrValue }[] {
  const entries: { path: string; value: KrValue }[] = [];
  spec.krs.forEach(k => entries.push({ path: `krs/${k.id}/value`, value: k.value }));
  spec.kpis.forEach(k => entries.push({ path: `kpis/${k.id}/value`, value: k.value }));
  spec.iniciativas.forEach(i => i.hitos.forEach((h, idx) =>
    entries.push({ path: `iniciativas/${i.id}/hitos/${idx}/value`, value: h.value })));
  spec.onePager.forEach(p => entries.push({ path: `onePager/${p.id}/value`, value: p.value }));
  return entries;
}

async function checkMetricExistence(spec: OkrBoardSpec, catalog: MetricCatalog): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const governed = collectValues(spec).filter(e => e.value.mode === "metric");
  await Promise.all(governed.map(async e => {
    const metric = (e.value as Extract<KrValue, { mode: "metric" }>).metric;
    if (!(await catalog.has(metric)))
      issues.push({ code: "unknown_metric", path: `${e.path}/metric`,
        message: `la métrica '${metric}' no existe en la capa semántica` });
  }));
  return issues;
}

export async function validateSpec(spec: OkrBoardSpec, catalog: MetricCatalog): Promise<ValidationIssue[]> {
  // a. contrato (JSON Schema)
  if (!validateSchema(spec)) {
    return (validateSchema.errors ?? []).map(e => ({
      code: "schema", path: e.instancePath || "/", message: `${e.keyword}: ${e.message}`,
    }));
  }
  // b. integridad referencial (síncrona, barata)
  const refIssues = checkReferentialIntegrity(spec);
  if (refIssues.length) return refIssues;           // corto acá: sin FKs sanas no vale consultar el catálogo
  // c. existencia de métrica (async, toca la capa semántica)
  return checkMetricExistence(spec, catalog);
}

// ----------------------------------------------------------------------------
// 6. Authz — derivada del acl del propio documento
// ----------------------------------------------------------------------------
function assertCanWrite(spec: OkrBoardSpec, principal: string, groupsOf: (p: string) => string[]): void {
  const mine = new Set([principal, ...groupsOf(principal)]);
  const entry = spec.doc.acl.find(a => mine.has(a.principal));
  if (!entry || entry.role === "viewer")
    throw new AuthzError(`${principal} no tiene permiso de escritura sobre ${spec.doc.id}`);
}

// ----------------------------------------------------------------------------
// 7. Pipeline — el único punto de escritura
// ----------------------------------------------------------------------------
export interface PipelineDeps {
  store: SpecStore;
  catalog: MetricCatalog;
  groupsOf?: (principal: string) => string[]; // resuelve membresías de grupo (ej: grupo:directorio)
  now?: () => string;
}

function describe(change: Change, principal: string): string {
  switch (change.op) {
    case "upsert_roca": return `roca ${change.roca.id} actualizada por ${principal}`;
    case "set_kr_value": return `valor de ${change.krId} (${change.value.mode}) por ${principal}`;
    case "upsert_kr": return `kr ${change.kr.id} (metadata) por ${principal}`;
    case "upsert_objetivo": return `objetivo ${change.objetivo.id} por ${principal}`;
    case "upsert_pilar": return `pilar ${change.pilar.id} por ${principal}`;
    case "upsert_negocio": return `negocio ${change.negocio.id} por ${principal}`;
    case "upsert_plataforma": return `plataforma ${change.plataforma.id} por ${principal}`;
    case "upsert_kpi": return `kpi ${change.kpi.id} (metadata) por ${principal}`;
    case "set_kpi_value": return `valor de kpi ${change.kpiId} (${change.value.mode}) por ${principal}`;
    case "upsert_iniciativa": return `iniciativa ${change.iniciativa.id} actualizada por ${principal}`;
    case "upsert_hito":
      return `hito ${change.index ?? "(nuevo)"} de iniciativa ${change.iniciativaId} por ${principal}`;
    case "remove_hito": return `hito ${change.index} de iniciativa ${change.iniciativaId} borrado por ${principal}`;
    case "upsert_scope_q":
      return `scope Q ${change.index ?? "(nuevo)"} de iniciativa ${change.iniciativaId} por ${principal}`;
    case "remove_scope_q":
      return `scope Q ${change.index} de iniciativa ${change.iniciativaId} borrado por ${principal}`;
    case "upsert_onepager_item": return `one pager item ${change.item.id} actualizado por ${principal}`;
    case "remove_entity": return `borrado ${change.entityType}:${change.id}${change.cascade ? " (cascade)" : ""} por ${principal}`;
  }
}

// Pasos 1-4 del invariante, compartidos por runWrite (que commitea) y runDryRun
// (que no). Nunca tocar el store de escritura acá: eso es responsabilidad exclusiva
// de runWrite, para que un dry-run no pueda, ni por error, dejar rastro en git.
async function prepareWrite(
  deps: PipelineDeps, principal: string, docId: string, baseVersion: string, change: Change,
): Promise<{ spec: OkrBoardSpec; next: OkrBoardSpec; issues: ValidationIssue[] }> {
  const groupsOf = deps.groupsOf ?? (() => []);
  const now = deps.now ?? (() => new Date().toISOString());

  const { spec, version } = await deps.store.readHead(docId);        // load HEAD
  if (version !== baseVersion)                                        // 1. concurrencia
    throw new ConcurrencyError(`base_version desactualizada: esperaba ${version}, recibí ${baseVersion}`);
  assertCanWrite(spec, principal, groupsOf);                          // 2. authz

  const next = applyChange(spec, change);                            // 3. cambio acotado (puro)
  next.doc.version = spec.doc.version + 1;
  next.doc.updated_at = now();

  const issues = await validateSpec(next, deps.catalog);             // 4. validación en cascada
  return { spec, next, issues };
}

export async function runWrite(
  deps: PipelineDeps, principal: string, docId: string, baseVersion: string, change: Change,
): Promise<{ version: string }> {
  const { next, issues } = await prepareWrite(deps, principal, docId, baseVersion, change);
  if (issues.length) throw new ValidationFailed(issues);             // rechazo SIN commit

  const newVersion = await deps.store.commit(                        // 5. commit atómico
    docId, next, describe(change, principal), baseVersion);
  return { version: newVersion };
}

// Dry-run de un cambio propuesto (M7): corre 1-4 y devuelve el spec resultante SIN
// commitear. A diferencia de validate_board (que valida lo ya guardado), esto muestra
// el efecto de un cambio todavía no confirmado — para previsualizar antes de escribir.
export async function runDryRun(
  deps: PipelineDeps, principal: string, docId: string, baseVersion: string, change: Change,
): Promise<{ spec: OkrBoardSpec; valid: boolean; errors: ValidationIssue[] }> {
  const { next, issues } = await prepareWrite(deps, principal, docId, baseVersion, change);
  return { spec: next, valid: issues.length === 0, errors: issues };
}

// Dry-run: valida el spec guardado sin escribir. Respaldo de la tool validate_board.
export async function runValidate(
  deps: PipelineDeps, docId: string,
): Promise<{ valid: boolean; errors: ValidationIssue[] }> {
  const { spec } = await deps.store.readHead(docId);
  const errors = await validateSpec(spec, deps.catalog);
  return { valid: errors.length === 0, errors };
}
