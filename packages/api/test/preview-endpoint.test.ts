import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequestHandler } from "../src/server";
import type { SpecStore, OkrBoardSpec } from "core";
import type { MetricResolver } from "../src/metric-resolver";

let pass = 0, fail = 0;
const ok = (c: boolean, l: string) => c ? (pass++, console.log("OK  " + l)) : (fail++, console.log("FALLO  " + l));

// Store fake: las rutas de preview nunca deberían llamarlo — si lo hacen, es un bug.
const untouchedStore: SpecStore = {
  readHead: async () => { throw new Error("preview no debería tocar el SpecStore"); },
  commit: async () => { throw new Error("preview no debería tocar el SpecStore"); },
};

// Resolver fake: mismo patrón que metric-resolver.test.ts (FakeLoader), pero acá
// directo porque solo necesitamos un resolve() fijo, no probar TTL/snapshot.
function fakeResolver(values: Record<string, number>): MetricResolver {
  return {
    async resolve(metric) {
      const v = values[metric.toUpperCase()];
      return v === undefined ? { value: null, error: "no sembrada" } : { value: v };
    },
  };
}

function baseSpec(): OkrBoardSpec {
  return {
    doc: { id: "doc1", type: "okr-board", title: "t", version: 1, updated_at: "2026-01-01T00:00:00Z", access: "domain", acl: [] },
    pilares: [], negocios: [], plataformas: [], objetivos: [], rocas: [], kpis: [], iniciativas: [], onePager: [],
    krs: [{ id: "k1", objId: "o1", desc: "d", sentido: "mayor", unidad: "%", target: 10, value: { mode: "literal", actual: 5 }, boards: [] }],
  } as unknown as OkrBoardSpec;
}

async function withServer(resolver: MetricResolver, run: (base: string) => Promise<void>) {
  const server = createServer(createRequestHandler({ store: untouchedStore, resolver }));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://localhost:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function main() {
  // 1. GET sin preview activo -> 404
  await withServer(fakeResolver({}), async (base) => {
    const res = await fetch(`${base}/api/boards/doc1/preview`);
    ok(res.status === 404, "GET preview sin publicar -> 404");
  });

  // 2. PUT publica, GET después lo devuelve resuelto
  await withServer(fakeResolver({ NMV: 42 }), async (base) => {
    const spec = baseSpec();
    (spec.krs[0] as any).value = { mode: "metric", metric: "nmv" };
    const put = await fetch(`${base}/api/boards/doc1/preview`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spec }),
    });
    ok(put.status === 200, "PUT preview -> 200");
    const putBody = await put.json();
    ok(putBody.resolved["krs/k1/value"] === 42, "PUT preview: resolved trae la métrica resuelta");

    const get = await fetch(`${base}/api/boards/doc1/preview`);
    ok(get.status === 200, "GET preview tras publicar -> 200");
    const getBody = await get.json();
    ok(getBody.spec.krs[0].id === "k1", "GET preview: devuelve el spec publicado");
    ok(getBody.resolved["krs/k1/value"] === 42, "GET preview: resolved consistente con el PUT");
  });

  // 3. DELETE limpia el slot -> siguiente GET vuelve a 404
  await withServer(fakeResolver({}), async (base) => {
    await fetch(`${base}/api/boards/doc1/preview`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spec: baseSpec() }),
    });
    const del = await fetch(`${base}/api/boards/doc1/preview`, { method: "DELETE" });
    ok(del.status === 204, "DELETE preview -> 204");
    const get = await fetch(`${base}/api/boards/doc1/preview`);
    ok(get.status === 404, "GET preview tras DELETE -> 404 de nuevo");
  });

  // 4. docs distintos no se pisan entre sí
  await withServer(fakeResolver({}), async (base) => {
    await fetch(`${base}/api/boards/docA/preview`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spec: { ...baseSpec(), doc: { ...baseSpec().doc, id: "docA" } } }),
    });
    const getB = await fetch(`${base}/api/boards/docB/preview`);
    ok(getB.status === 404, "preview de docA no aparece bajo docB");
  });

  // 5. PUT sin 'spec' en el body -> 400, no revienta el proceso
  await withServer(fakeResolver({}), async (base) => {
    const res = await fetch(`${base}/api/boards/doc1/preview`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    ok(res.status === 400, "PUT sin spec -> 400");
  });

  // 6. el board real (GET /api/boards/:id) sigue andando igual con el handler extraído
  await withServer(fakeResolver({ NMV: 7 }), async (base) => {
    const store: SpecStore = {
      readHead: async (docId) => ({ spec: baseSpec(), version: "v1" }),
      commit: async () => { throw new Error("no usado en este test"); },
    };
    const server = createServer(createRequestHandler({ store, resolver: fakeResolver({}) }));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://localhost:${port}/api/boards/doc1`);
      const body = await res.json();
      ok(res.status === 200 && body.version === "v1", "GET board real sigue funcionando tras extraer createRequestHandler");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  console.log(`\n${pass} OK · ${fail} FALLO`);
  if (fail) process.exit(1);
}

main();
