import {
  runWrite, runValidate, runDryRun, applyChange,
  AuthzError, ConcurrencyError, ValidationFailed,
  type OkrBoardSpec, type SpecStore, type MetricCatalog, type PipelineDeps,
} from "../src/pipeline";

// ---- fakes en memoria ----
class InMemoryStore implements SpecStore {
  private v = 1;
  constructor(private spec: OkrBoardSpec) {}
  async readHead(_: string) { return { spec: structuredClone(this.spec), version: String(this.v) }; }
  async commit(_: string, spec: OkrBoardSpec, __: string, expected: string) {
    if (expected !== String(this.v)) throw new ConcurrencyError("HEAD movido");
    this.v += 1; this.spec = structuredClone(spec); return String(this.v);
  }
  get version() { return String(this.v); }
}
const catalog: MetricCatalog = { async has(m) { return ["nmv", "utilidad_gni"].includes(m); } };
const groupsOf = (p: string) => (p === "@lucia" ? ["grupo:directorio"] : []);

function baseSpec(): OkrBoardSpec {
  return {
    doc: {
      id: "board-2026", type: "okr-board", title: "Test", version: 1,
      updated_at: "2026-07-30T00:00:00-03:00", access: "domain",
      acl: [{ principal: "@dionisio", role: "owner" }, { principal: "grupo:directorio", role: "viewer" }],
    },
    pilares: [{ id: "p1", nombre: "Rentabilidad", desc: "", okrIds: ["o1"] }],
    negocios: [{ id: "n1", nombre: "Ecommerce AR" }],
    plataformas: [],
    objetivos: [{ id: "o1", negocioId: "n1", nombre: "Utilidad", texto: "..." }],
    krs: [
      { id: "k1", objId: "o1", desc: "KR literal", sentido: "mayor", unidad: "%", target: 10,
        value: { mode: "literal", actual: 7.66, prev: 7.8, as_of: "2026-07-30" } },
      { id: "k12", objId: "o1", desc: "KR gobernado", sentido: "mayor", unidad: "M USD", target: 32,
        value: { mode: "metric", metric: "utilidad_gni", filter: { period: "2026-YTD" } } },
    ],
    rocas: [{ id: "r1", nombre: "Roca uno", detalle: "", area: "Comercial", equipo: null,
      trimestre: "Q3", estado: "no_iniciada", columna: "Prioridades Q3", krIds: ["k1"], pilarIds: ["p1"] }],
    kpis: [
      { id: "kpi1", pilarId: "p1", negocioId: "n1", nombre: "KPI test", sentido: "mayor", unidad: "%",
        target: 50, value: { mode: "literal", actual: 40 } },
    ],
    iniciativas: [
      { id: "ini1", prioridad: 1, nombre: "Iniciativa test", sponsor: "", owner: "Alguien", equipo: "",
        pilarId: "p1", scopeIniciativa: "Probar iniciativas.",
        hitos: [{ texto: "Hito 1", sentido: "mayor", unidad: "", target: 1, value: { mode: "literal", actual: 0 } }],
        scopesQ: [], riesgos: "", riesgoSemaforo: null, rocaIds: ["r1"] },
    ],
    onePager: [
      { id: "op1", negocioId: "n1", grupo: "Rentabilidad", sentido: "mayor", nombre: "NMV", unidad: "M USD",
        target: 100, value: { mode: "literal", actual: 80 }, children: [{ nombre: "Canal A", actual: 50 }] },
    ],
  };
}

// ---- mini harness ----
let pass = 0, fail = 0;
function ok(cond: boolean, label: string) { cond ? (pass++, console.log("OK  " + label)) : (fail++, console.log("FALLO  " + label)); }
async function expectReject(fn: () => Promise<unknown>, ErrType: Function, label: string) {
  try { await fn(); ok(false, label + " (no lanzó)"); }
  catch (e) { ok(e instanceof ErrType, label + (e instanceof ErrType ? "" : ` (lanzó ${(e as Error).constructor.name})`)); }
}

async function main() {
  const deps = (store: SpecStore): PipelineDeps => ({ store, catalog, groupsOf, now: () => "2026-07-30T12:00:00-03:00" });

  // 1. happy: marcar roca completada (merge parcial)
  {
    const store = new InMemoryStore(baseSpec());
    const { version } = await runWrite(deps(store), "@dionisio", "board-2026", "1",
      { op: "upsert_roca", roca: { id: "r1", estado: "completada", columna: "Terminado" } });
    ok(version === "2", "happy: upsert_roca commitea y bumpea versión (1 -> 2)");
    const { spec } = await store.readHead("board-2026");
    ok(spec.rocas[0].estado === "completada" && spec.rocas[0].nombre === "Roca uno",
      "happy: merge parcial cambió estado y preservó el resto");
    ok(spec.doc.version === 2, "happy: doc.version incrementado");
  }

  // 2. concurrencia: base_version desactualizada
  await expectReject(() => runWrite(deps(new InMemoryStore(baseSpec())), "@dionisio", "board-2026", "999",
    { op: "upsert_roca", roca: { id: "r1", estado: "completada" } }), ConcurrencyError,
    "concurrencia: base_version stale -> ConcurrencyError");

  // 3. authz: viewer (por grupo) no puede escribir
  await expectReject(() => runWrite(deps(new InMemoryStore(baseSpec())), "@lucia", "board-2026", "1",
    { op: "upsert_roca", roca: { id: "r1", estado: "completada" } }), AuthzError,
    "authz: @lucia (viewer via grupo:directorio) -> AuthzError");

  // 3b. authz: principal ajeno al acl
  await expectReject(() => runWrite(deps(new InMemoryStore(baseSpec())), "@ajeno", "board-2026", "1",
    { op: "upsert_roca", roca: { id: "r1", estado: "completada" } }), AuthzError,
    "authz: @ajeno (fuera del acl) -> AuthzError");

  // 4. schema: estado fuera del enum
  await expectReject(() => runWrite(deps(new InMemoryStore(baseSpec())), "@dionisio", "board-2026", "1",
    { op: "upsert_roca", roca: { id: "r1", estado: "en_curso" as any } }), ValidationFailed,
    "schema: estado inválido -> ValidationFailed");

  // 5. FK: roca apunta a un kr inexistente
  await expectReject(() => runWrite(deps(new InMemoryStore(baseSpec())), "@dionisio", "board-2026", "1",
    { op: "upsert_roca", roca: { id: "r2", nombre: "nueva", detalle: "", area: "X", equipo: null,
      trimestre: null, estado: "no_iniciada", columna: "Pendientes", krIds: ["kZ"], pilarIds: [] } }),
    ValidationFailed, "FK: krId inexistente -> ValidationFailed");

  // 6. métrica inexistente
  await expectReject(() => runWrite(deps(new InMemoryStore(baseSpec())), "@dionisio", "board-2026", "1",
    { op: "set_kr_value", krId: "k1", value: { mode: "metric", metric: "no_existe" } }),
    ValidationFailed, "métrica: 'no_existe' -> ValidationFailed");

  // 7. métrica válida: migrar k1 a gobernado
  {
    const store = new InMemoryStore(baseSpec());
    const { version } = await runWrite(deps(store), "@dionisio", "board-2026", "1",
      { op: "set_kr_value", krId: "k1", value: { mode: "metric", metric: "nmv", filter: { period: "2026-06" } } });
    const { spec } = await store.readHead("board-2026");
    ok(version === "2" && spec.krs[0].value.mode === "metric",
      "métrica válida: set_kr_value migra k1 literal -> metric(nmv)");
  }

  // 8. remove sin cascade: k1 está referenciado por r1 -> rechaza
  await expectReject(() => runWrite(deps(new InMemoryStore(baseSpec())), "@dionisio", "board-2026", "1",
    { op: "remove_entity", entityType: "kr", id: "k1", cascade: false }), ValidationFailed,
    "remove: kr referenciado sin cascade -> ValidationFailed");

  // 9. remove con cascade: borra k1 y limpia r1.krIds
  {
    const store = new InMemoryStore(baseSpec());
    await runWrite(deps(store), "@dionisio", "board-2026", "1",
      { op: "remove_entity", entityType: "kr", id: "k1", cascade: true });
    const { spec } = await store.readHead("board-2026");
    ok(!spec.krs.some(k => k.id === "k1") && !spec.rocas[0].krIds.includes("k1"),
      "remove cascade: k1 borrado y limpiado de r1.krIds");
  }

  // 10. cascada profunda: borrar objetivo o1 -> borra k1,k12 (FK escalar) y limpia p1.okrIds y r1.krIds
  {
    const spec = applyChange(baseSpec(), { op: "remove_entity", entityType: "objetivo", id: "o1", cascade: true });
    ok(spec.objetivos.length === 0 && spec.krs.length === 0 &&
       spec.pilares[0].okrIds.length === 0 && spec.rocas[0].krIds.length === 0,
      "remove cascade profundo: borrar objetivo arrastra sus KRs y limpia todas las refs");
  }

  // 11. validate_board (dry-run guardado) sobre spec sano
  {
    const { valid } = await runValidate(deps(new InMemoryStore(baseSpec())), "board-2026");
    ok(valid, "validate_board: spec base es válido");
  }

  // 12. upsert_kpi happy: merge parcial
  {
    const store = new InMemoryStore(baseSpec());
    const { version } = await runWrite(deps(store), "@dionisio", "board-2026", "1",
      { op: "upsert_kpi", kpi: { id: "kpi1", target: 60 } });
    const { spec } = await store.readHead("board-2026");
    ok(version === "2" && spec.kpis[0].target === 60 && spec.kpis[0].nombre === "KPI test",
      "kpi: upsert_kpi merge parcial actualiza target y preserva el resto");
  }

  // 13. kpi FK: pilarId inexistente
  await expectReject(() => runWrite(deps(new InMemoryStore(baseSpec())), "@dionisio", "board-2026", "1",
    { op: "upsert_kpi", kpi: { id: "kpi2", pilarId: "pZ", negocioId: "n1", nombre: "nuevo", sentido: "mayor",
      unidad: "%", target: null, value: { mode: "literal", actual: null } } as any }),
    ValidationFailed, "kpi FK: pilarId inexistente -> ValidationFailed");

  // 14. kpi FK: negocioId inexistente
  await expectReject(() => runWrite(deps(new InMemoryStore(baseSpec())), "@dionisio", "board-2026", "1",
    { op: "upsert_kpi", kpi: { id: "kpi1", negocioId: "nZ" } }), ValidationFailed,
    "kpi FK: negocioId inexistente -> ValidationFailed");

  // 15. kpi métrica inexistente
  await expectReject(() => runWrite(deps(new InMemoryStore(baseSpec())), "@dionisio", "board-2026", "1",
    { op: "set_kpi_value", kpiId: "kpi1", value: { mode: "metric", metric: "no_existe" } }),
    ValidationFailed, "kpi métrica: 'no_existe' -> ValidationFailed");

  // 16. kpi métrica válida: migra kpi1 literal -> metric(nmv)
  {
    const store = new InMemoryStore(baseSpec());
    await runWrite(deps(store), "@dionisio", "board-2026", "1",
      { op: "set_kpi_value", kpiId: "kpi1", value: { mode: "metric", metric: "nmv" } });
    const { spec } = await store.readHead("board-2026");
    ok(spec.kpis[0].value.mode === "metric", "kpi métrica válida: set_kpi_value migra kpi1 literal -> metric(nmv)");
  }

  // 17. upsert_iniciativa happy: merge parcial
  {
    const store = new InMemoryStore(baseSpec());
    await runWrite(deps(store), "@dionisio", "board-2026", "1",
      { op: "upsert_iniciativa", iniciativa: { id: "ini1", nombre: "Iniciativa renombrada" } });
    const { spec } = await store.readHead("board-2026");
    ok(spec.iniciativas[0].nombre === "Iniciativa renombrada" && spec.iniciativas[0].rocaIds.includes("r1"),
      "iniciativa: upsert_iniciativa merge parcial renombra y preserva rocaIds");
  }

  // 18. iniciativa FK: rocaId inexistente
  await expectReject(() => runWrite(deps(new InMemoryStore(baseSpec())), "@dionisio", "board-2026", "1",
    { op: "upsert_iniciativa", iniciativa: { id: "ini1", rocaIds: ["rZ"] } }), ValidationFailed,
    "iniciativa FK: rocaId inexistente -> ValidationFailed");

  // 19. iniciativa: hito con métrica inexistente (generalización de checkMetricExistence a rutas anidadas)
  await expectReject(() => runWrite(deps(new InMemoryStore(baseSpec())), "@dionisio", "board-2026", "1",
    { op: "upsert_iniciativa", iniciativa: { id: "ini1", hitos: [
      { texto: "Hito con métrica mala", sentido: "mayor", unidad: "", target: 1,
        value: { mode: "metric", metric: "no_existe" } } ] } }),
    ValidationFailed, "iniciativa: hito con métrica inexistente -> ValidationFailed");

  // 20. remove roca sin cascade: r1 referenciada por ini1.rocaIds -> rechaza
  await expectReject(() => runWrite(deps(new InMemoryStore(baseSpec())), "@dionisio", "board-2026", "1",
    { op: "remove_entity", entityType: "roca", id: "r1", cascade: false }), ValidationFailed,
    "remove: roca referenciada por iniciativa sin cascade -> ValidationFailed");

  // 21. remove roca con cascade: limpia ini1.rocaIds
  {
    const spec = applyChange(baseSpec(), { op: "remove_entity", entityType: "roca", id: "r1", cascade: true });
    ok(!spec.rocas.some(r => r.id === "r1") && !spec.iniciativas[0].rocaIds.includes("r1"),
      "remove cascade: roca borrada y limpiada de iniciativa.rocaIds");
  }

  // 22. remove pilar con cascade: borra su kpi (scalar) y pone en null iniciativa.pilarId (nullableScalar)
  {
    const spec = applyChange(baseSpec(), { op: "remove_entity", entityType: "pilar", id: "p1", cascade: true });
    ok(spec.pilares.length === 0 && !spec.kpis.some(k => k.pilarId === "p1") &&
       spec.iniciativas[0].pilarId === null && spec.rocas[0].pilarIds.length === 0,
      "remove cascade: pilar borra su kpi, limpia r1.pilarIds y pone en null ini1.pilarId");
  }

  // 23. upsert_onepager_item happy: merge parcial preserva children
  {
    const store = new InMemoryStore(baseSpec());
    await runWrite(deps(store), "@dionisio", "board-2026", "1",
      { op: "upsert_onepager_item", item: { id: "op1", target: 120 } });
    const { spec } = await store.readHead("board-2026");
    ok(spec.onePager[0].target === 120 && spec.onePager[0].children?.[0]?.nombre === "Canal A",
      "onePager: upsert_onepager_item merge parcial actualiza target y preserva children");
  }

  // 24. onePager FK: negocioId inexistente
  await expectReject(() => runWrite(deps(new InMemoryStore(baseSpec())), "@dionisio", "board-2026", "1",
    { op: "upsert_onepager_item", item: { id: "op1", negocioId: "nZ" } }), ValidationFailed,
    "onePager FK: negocioId inexistente -> ValidationFailed");

  // 25. onePager: métrica inexistente
  await expectReject(() => runWrite(deps(new InMemoryStore(baseSpec())), "@dionisio", "board-2026", "1",
    { op: "upsert_onepager_item", item: { id: "op1", value: { mode: "metric", metric: "no_existe" } } }),
    ValidationFailed, "onePager métrica: 'no_existe' -> ValidationFailed");

  // 26. dry-run (M7): no commitea, devuelve el spec con el cambio aplicado
  {
    const store = new InMemoryStore(baseSpec());
    const { spec, valid, errors } = await runDryRun(deps(store), "@dionisio", "board-2026", "1",
      { op: "upsert_roca", roca: { id: "r1", estado: "completada" } });
    const stillHead = await store.readHead("board-2026");
    ok(valid && errors.length === 0 && spec.rocas[0].estado === "completada",
      "dry-run: valida ok y devuelve el spec con el cambio aplicado");
    ok(stillHead.version === "1" && stillHead.spec.rocas[0].estado === "no_iniciada",
      "dry-run: NO commitea (el store queda intacto en HEAD original)");
  }

  // 27. dry-run (M7): cambio inválido -> valid:false sin lanzar y sin commitear
  {
    const store = new InMemoryStore(baseSpec());
    const { valid, errors } = await runDryRun(deps(store), "@dionisio", "board-2026", "1",
      { op: "set_kr_value", krId: "k1", value: { mode: "metric", metric: "no_existe" } });
    const stillHead = await store.readHead("board-2026");
    ok(!valid && errors.length > 0, "dry-run: cambio inválido devuelve valid:false con errors, sin lanzar");
    ok(stillHead.version === "1", "dry-run: cambio inválido tampoco commitea");
  }

  console.log(`\n${pass} OK · ${fail} FALLO`);
  if (fail) process.exit(1);
}

main();
