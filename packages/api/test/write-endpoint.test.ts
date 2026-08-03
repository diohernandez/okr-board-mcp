import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequestHandler } from "../src/server";
import { ConcurrencyError, type SpecStore, type OkrBoardSpec, type MetricCatalog } from "core";
import type { MetricResolver } from "../src/metric-resolver";

let pass = 0, fail = 0;
const ok = (c: boolean, l: string) => c ? (pass++, console.log("OK  " + l)) : (fail++, console.log("FALLO  " + l));

// Mismo patrón que InMemoryStore de packages/core/test/pipeline.test.ts: store real
// en memoria (no un mock que solo cuenta llamadas) para poder afirmar sobre el
// contenido persistido, no solo sobre el status code.
class FakeStore implements SpecStore {
  private v = 1;
  constructor(private spec: OkrBoardSpec) {}
  async readHead(_docId: string) { return { spec: structuredClone(this.spec), version: String(this.v) }; }
  async commit(_docId: string, spec: OkrBoardSpec, _msg: string, expected: string) {
    if (expected !== String(this.v)) throw new ConcurrencyError(`stale: HEAD=${this.v}, recibí ${expected}`);
    this.v += 1; this.spec = structuredClone(spec); return String(this.v);
  }
}

const catalog: MetricCatalog = { async has(m) { return ["nmv"].includes(m.toLowerCase()); } };
const resolver: MetricResolver = { async resolve() { return { value: null, error: "no usado en este test" }; } };

function baseSpec(): OkrBoardSpec {
  return {
    doc: {
      id: "doc1", type: "okr-board", title: "t", version: 1, updated_at: "2026-01-01T00:00:00Z",
      access: "domain", acl: [{ principal: "@dionisio", role: "owner" }, { principal: "@viewer", role: "viewer" }],
    },
    pilares: [], negocios: [], plataformas: [], objetivos: [], kpis: [], iniciativas: [], onePager: [], krs: [],
    rocas: [{ id: "r1", nombre: "Roca uno", detalle: "", area: "X", equipo: null, trimestre: null,
      estado: "no_iniciada", columna: "Pendientes", krIds: [], pilarIds: [] }],
  } as unknown as OkrBoardSpec;
}

async function withServer(spec: OkrBoardSpec, run: (base: string, store: FakeStore) => Promise<void>) {
  const store = new FakeStore(spec);
  const server = createServer(createRequestHandler({ store, resolver, catalog, principal: "@dionisio" }));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://localhost:${port}`, store);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function main() {
  // 1. tool desconocida -> 404
  await withServer(baseSpec(), async (base) => {
    const res = await post(base, "/api/boards/doc1/tools/no_existe", { base_version: "1" });
    ok(res.status === 404, "POST tool desconocida -> 404");
  });

  // 2. método incorrecto sobre una ruta de tool válida -> 405
  await withServer(baseSpec(), async (base) => {
    const res = await fetch(`${base}/api/boards/doc1/tools/upsert_roca`);
    ok(res.status === 405, "GET sobre /tools/:name -> 405 (solo POST)");
  });

  // 3. falta base_version -> 400
  await withServer(baseSpec(), async (base) => {
    const res = await post(base, "/api/boards/doc1/tools/upsert_roca", { roca: { id: "r1", estado: "completada" } });
    ok(res.status === 400, "POST sin base_version -> 400");
  });

  // 4. happy: write real, se persiste en el store
  await withServer(baseSpec(), async (base, store) => {
    const res = await post(base, "/api/boards/doc1/tools/upsert_roca",
      { base_version: "1", roca: { id: "r1", estado: "completada" } });
    const body = await res.json();
    ok(res.status === 200 && body.version === "2", "POST upsert_roca happy -> 200 {version:'2'}");
    const head = await store.readHead("doc1");
    ok(head.spec.rocas[0].estado === "completada", "el write quedó persistido de verdad en el store");
  });

  // 5. base_version stale -> 409 (ConcurrencyError)
  await withServer(baseSpec(), async (base) => {
    const res = await post(base, "/api/boards/doc1/tools/upsert_roca",
      { base_version: "999", roca: { id: "r1", estado: "completada" } });
    ok(res.status === 409, "POST con base_version stale -> 409");
  });

  // 6. cambio inválido (FK: krIds apunta a un kr inexistente) -> 422 con issues
  await withServer(baseSpec(), async (base) => {
    const res = await post(base, "/api/boards/doc1/tools/upsert_roca",
      { base_version: "1", roca: { id: "r1", krIds: ["kZ"] } });
    const body = await res.json();
    ok(res.status === 422 && Array.isArray(body.issues) && body.issues.length > 0,
      "POST con FK inválida -> 422 con issues[]");
  });

  // 7. dry_run: no commitea, devuelve spec+valid+resolved
  await withServer(baseSpec(), async (base, store) => {
    const res = await post(base, "/api/boards/doc1/tools/upsert_roca",
      { base_version: "1", roca: { id: "r1", estado: "completada" }, dry_run: true });
    const body = await res.json();
    ok(res.status === 200 && body.valid === true && body.spec.rocas[0].estado === "completada",
      "POST dry_run:true -> 200 {valid:true, spec con el cambio aplicado}");
    const head = await store.readHead("doc1");
    ok(head.version === "1" && head.spec.rocas[0].estado === "no_iniciada",
      "dry_run NO commiteó (el store sigue en la versión original)");
  });

  // 8. authz: principal sin permiso de escritura (el server corre como @dionisio,
  // pero el spec dice que @dionisio es owner -- probamos el rechazo cambiando el ACL
  // para que @dionisio quede afuera).
  await withServer({ ...baseSpec(), doc: { ...baseSpec().doc, acl: [{ principal: "@otro", role: "owner" }] } },
    async (base) => {
      const res = await post(base, "/api/boards/doc1/tools/upsert_roca",
        { base_version: "1", roca: { id: "r1", estado: "completada" } });
      ok(res.status === 401, "POST con principal fuera del ACL -> 401 (AuthzError)");
    });

  // 9. un write real invalida cualquier preview viejo del mismo doc (mismo criterio
  // que clearPreview() del MCP)
  await withServer(baseSpec(), async (base) => {
    await fetch(`${base}/api/boards/doc1/preview`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spec: baseSpec() }),
    });
    const before = await fetch(`${base}/api/boards/doc1/preview`);
    ok(before.status === 200, "preview publicado antes del write real -> 200");
    await post(base, "/api/boards/doc1/tools/upsert_roca", { base_version: "1", roca: { id: "r1", estado: "completada" } });
    const after = await fetch(`${base}/api/boards/doc1/preview`);
    ok(after.status === 404, "tras un write real, el preview viejo del mismo doc queda invalidado");
  });

  console.log(`\n${pass} OK · ${fail} FALLO`);
  if (fail) process.exit(1);
}

main();
