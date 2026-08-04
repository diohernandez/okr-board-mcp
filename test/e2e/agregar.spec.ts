import { test, expect, type Page, type Locator, type APIRequestContext } from "@playwright/test";

// F4 E2E — flujo "Agregar": crea pilar -> objetivo (vinculado a ese pilar) -> KR
// (bajo ese objetivo) -> roca -> kpi, en un browser real, contra el API real (repo
// aislado, ver setup-repo.mjs). Verificamos el TRIGGER vía la UI (click real en el
// botón real) y la PERSISTENCIA vía una llamada directa al API -- más confiable que
// buscar el resultado en el DOM anidado, y es lo que realmente importa: que el click
// haya disparado el write real, no que el render tenga tal o tal forma.
//
// Un solo test encadenado a propósito: cada alta depende del id/nombre creado en la
// anterior (el <select> de objetivo necesita el pilar nuevo; el de KR, el objetivo).

const API = "http://localhost:8788/api/boards/despliegue-estrategico-2026";

async function getSpec(request: APIRequestContext) {
  const res = await request.get(API);
  return (await res.json()).spec;
}

// Click en un botón "Agregar X" + esperar el GET del reloadAfterWrite() del propio
// browser (no solo "networkidle": entre dos POSTs SECUENCIALES de una misma acción
// -ej: addObjetivo hace upsert_objetivo y LUEGO upsert_pilar- hay un hueco breve sin
// requests en vuelo que "networkidle" puede confundir con el final, resolviendo ANTES
// de que el segundo POST + el reload siquiera arranquen. Esperar el GET final del board
// (que solo pasa una vez, al final de reloadAfterWrite) ancla el momento exacto.
async function clickAndWaitForReload(page: Page, button: Locator) {
  await Promise.all([
    page.waitForResponse((r) => r.url() === API && r.request().method() === "GET"),
    button.click(),
  ]);
}

// El form de "+ Agregar Pilar" vive en la pestaña de TOP NAV "Pilares Estratégicos"
// (view-pilares-standalone) -- NO dentro del panel de otrosElementos (ese solo tiene
// Objetivo/KR/Roca/KPI). Es un <div data-section> con onclick, no un <button>.
async function goToPilares(page: Page) {
  await page.locator('[data-section="pilares"]').click();
  await expect(page.locator("#newPilarName")).toBeVisible();
}

// setSubview('okrs','agregar') puede esconder sub-agregar al recargar/re-renderizar
// (reloadAfterWrite -> renderAll no preserva la sub-pestaña, mismo gap ya conocido de
// pollForChanges) -- re-clickear el tab siempre; el toggle interno de
// #otrosElementosPanel es un simple display:none/block que SÍ sobrevive a renderAll,
// pero abrirlo de nuevo si por lo que sea quedó cerrado es gratis y más robusto.
// "Iniciativas Estratégicas" vive DENTRO del top section "Negocios" (#subnavOkrs) --
// si el paso anterior (ej: addPilar) dejó otro top section activo, hay que volver.
async function goToAgregar(page: Page) {
  await page.locator('[data-section="negocios"]').click();
  await page.getByRole("button", { name: "Iniciativas Estratégicas" }).click();
  const panel = page.locator("#otrosElementosPanel");
  if (!(await panel.isVisible())) {
    await page.locator("#otrosElementosToggle").click();
  }
  await expect(panel).toBeVisible();
}

test("crea pilar, objetivo, KR, roca y KPI desde la UI real", async ({ page, request }) => {
  const suffix = Date.now().toString().slice(-6);
  await page.goto("/");

  const pilarName = `Pilar E2E ${suffix}`;
  await test.step("addPilar", async () => {
    await goToPilares(page);
    await page.locator("#newPilarName").fill(pilarName);
    await page.locator("#newPilarDesc").fill("desc e2e");
    await clickAndWaitForReload(page, page.getByRole("button", { name: "Agregar pilar" }));
    await expect.poll(async () => (await getSpec(request)).pilares.some((p: any) => p.nombre === pilarName))
      .toBe(true);
  });

  const objNombre = `Objetivo E2E ${suffix}`;
  await test.step("addObjetivo, vinculado al pilar recién creado", async () => {
    await goToAgregar(page);
    await page.locator("#newObjNombre").fill(objNombre);
    await page.locator("#newObjTexto").fill("texto e2e");
    await page.locator("#newObjPilar").selectOption({ label: pilarName });
    // dos writes secuenciales (objetivo + vincular al pilar) -> dos reloads; esperar
    // el GET final, no el primero.
    await clickAndWaitForReload(page, page.getByRole("button", { name: "Agregar objetivo" }));
    await expect.poll(async () => {
      const spec = await getSpec(request);
      const obj = spec.objetivos.find((o: any) => o.nombre === objNombre);
      const pilar = spec.pilares.find((p: any) => p.nombre === pilarName);
      return !!obj && !!pilar && pilar.okrIds.includes(obj.id);
    }).toBe(true);
  });

  const krDesc = `KR E2E ${suffix}`;
  await test.step("addKR bajo ese objetivo (prueba el fix de upsert_kr + set_kr_value)", async () => {
    await goToAgregar(page);
    await page.locator("#newKrObjetivo").selectOption({ label: objNombre });
    await page.locator("#newKrDesc").fill(krDesc);
    await page.locator("#newKrUnidad").fill("%");
    await clickAndWaitForReload(page, page.getByRole("button", { name: "Agregar KR" }));
    await expect.poll(async () => {
      const spec = await getSpec(request);
      const kr = spec.krs.find((k: any) => k.desc === krDesc);
      // el fix del pipeline debe haberle puesto value:{mode:'literal',actual:null} solo
      return !!kr && kr.value?.mode === "literal" && kr.value?.actual === null;
    }).toBe(true);
  });

  const rocaName = `Roca E2E ${suffix}`;
  await test.step("addRoca", async () => {
    await goToAgregar(page);
    await page.locator("#newRocaName").fill(rocaName);
    await page.locator("#newRocaArea").fill("QA");
    await clickAndWaitForReload(page, page.getByRole("button", { name: "Agregar roca" }));
    await expect.poll(async () => (await getSpec(request)).rocas.some((r: any) => r.nombre === rocaName))
      .toBe(true);
  });

  const kpiNombre = `KPI E2E ${suffix}`;
  await test.step("addKpi (prueba el mismo fix que addKR, para upsert_kpi + set_kpi_value)", async () => {
    await goToAgregar(page);
    await page.locator("#newKpiNombre").fill(kpiNombre);
    await page.locator("#newKpiUnidad").fill("%");
    await clickAndWaitForReload(page, page.getByRole("button", { name: "Agregar KPI" }));
    await expect.poll(async () => {
      const spec = await getSpec(request);
      const kpi = spec.kpis.find((k: any) => k.nombre === kpiNombre);
      return !!kpi && kpi.value?.mode === "literal" && kpi.value?.actual === null;
    }).toBe(true);
  });
});
