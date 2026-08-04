import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

// F4 E2E — flujos "Cargar Datos" y "Rocas", sobre las entidades pre-seedeadas por
// setup-repo.mjs (k1/kpi1/op1/r1). Mismo criterio que agregar.spec.ts: la UI dispara
// el write real, el API confirma que persistió.
const API = "http://localhost:8788/api/boards/despliegue-estrategico-2026";
async function getSpec(request: APIRequestContext) {
  const res = await request.get(API);
  return (await res.json()).spec;
}

// Esperar la respuesta GET del board (no solo el evento 'load' de goto) antes de
// clickear: loadData() es async y corre DESPUÉS de 'load' -- sin esto, un click
// disparado demasiado rápido cae mientras `data` todavía es el estado inicial vacío,
// y renderDatosView() arma la tabla sin filas (encontrado corriendo esto de verdad:
// el segundo goToDatos() de la misma sesión de test, sin ningún delay natural antes,
// no encontraba la fila que el PRIMERO sí había encontrado bien).
async function goToDatos(page: Page) {
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/boards/despliegue-estrategico-2026") && r.request().method() === "GET"),
    page.goto("/"),
  ]);
  await page.locator("#datosBtn").click();
  await expect(page.locator("#view-datos")).toBeVisible();
}

test("Cargar Datos: KR — 'actual' (literal), 'unidad'/'sentido' (metadata) y toggleKrDg", async ({ page, request }) => {
  await goToDatos(page);
  const row = page.locator("#datosOkrsTable tr", { hasText: "KR Fixture" });
  const inputs = row.locator("input[type=number]");

  // .blur() en vez de dispatchEvent("change") a propósito: dispatchEvent dispara el
  // handler UNA vez, pero el input sigue con foco -- al interactuar después con OTRO
  // campo, el browser dispara un change NATIVO adicional al perder el foco, duplicando
  // este write (encontrado corriendo esto de verdad: dos commits "valor de k1" por una
  // sola acción). .blur() consume el foco ahora, evitando el disparo tardío.
  await test.step("updateDatosField 'actual' vía set_kr_value", async () => {
    await inputs.nth(0).fill("42");
    await inputs.nth(0).blur();
    await expect.poll(async () => (await getSpec(request)).krs.find((k: any) => k.id === "k1").value.actual)
      .toBe(42);
  });

  await test.step("updateKr metadata: unidad", async () => {
    await row.locator("input[type=text]").fill("días");
    await row.locator("input[type=text]").blur();
    await expect.poll(async () => (await getSpec(request)).krs.find((k: any) => k.id === "k1").unidad)
      .toBe("días");
  });

  await test.step("toggleKrDg reconstruye 'boards'", async () => {
    await row.locator("input[type=checkbox]").check();
    await expect.poll(async () => (await getSpec(request)).krs.find((k: any) => k.id === "k1").boards)
      .toContain("direccion_general");
  });

  await test.step("el valor 'actual' persiste tras recargar la página (round-trip completo por el browser)", async () => {
    await goToDatos(page);
    const reloadedRow = page.locator("#datosOkrsTable tr", { hasText: "KR Fixture" });
    await expect(reloadedRow.locator("input[type=number]").nth(0)).toHaveValue("42");
  });
});

test("Cargar Datos: KPI — 'target' (metadata) y KPI 'actual' (literal)", async ({ page, request }) => {
  await goToDatos(page);
  const row = page.locator("#datosPilaresTable tr", { hasText: "KPI Fixture" });

  await test.step("updateDatosField 'target' vía upsert_kpi", async () => {
    const targetInput = row.locator("input[type=number]").nth(1);
    await targetInput.fill("99");
    await targetInput.blur();
    await expect.poll(async () => (await getSpec(request)).kpis.find((k: any) => k.id === "kpi1").target)
      .toBe(99);
  });

  await test.step("updateDatosField 'actual' vía set_kpi_value", async () => {
    const actualInput = row.locator("input[type=number]").nth(0);
    await actualInput.fill("7");
    await actualInput.blur();
    await expect.poll(async () => (await getSpec(request)).kpis.find((k: any) => k.id === "kpi1").value.actual)
      .toBe(7);
  });
});

test("Cargar Datos: onePager — 'unidad' (metadata)", async ({ page, request }) => {
  await goToDatos(page);
  const row = page.locator("#datosOnePagerTable tr", { hasText: "NMV Fixture" });
  await row.locator("input[type=text]").fill("K USD");
  await row.locator("input[type=text]").blur();
  await expect.poll(async () => (await getSpec(request)).onePager.find((o: any) => o.id === "op1").unidad)
    .toBe("K USD");
});

// Espera el GET final de reloadAfterWrite() antes de seguir -- mismo motivo que
// clickAndWaitForReload() en agregar.spec.ts: sin esto, el siguiente click de
// navegación puede caer mientras el re-render de ESTE write todavía está en vuelo
// ("element is not stable" / "not visible", encontrado corriendo esto de verdad).
async function actionAndWaitForReload(page: Page, action: () => Promise<void>) {
  await Promise.all([
    page.waitForResponse((r) => r.url() === API && r.request().method() === "GET"),
    action(),
  ]);
}

async function goToRocasAsignar(page: Page) {
  await page.getByRole("button", { name: "Rocas", exact: true }).click();
  await page.getByRole("button", { name: "Asignar Rocas a KRs" }).click();
}

test("Rocas: updateRocaEstado y toggleRocaKr (asignar/desasignar)", async ({ page, request }) => {
  await page.goto("/");
  await goToRocasAsignar(page);

  await test.step("updateRocaEstado desde el select del panel Asignar", async () => {
    const card = page.locator(".roca-card", { hasText: "Roca Fixture" });
    await actionAndWaitForReload(page, () => card.locator("select.estado-select").selectOption("completada"));
    await expect.poll(async () => (await getSpec(request)).rocas.find((r: any) => r.id === "r1").estado)
      .toBe("completada");
  });

  await test.step("toggleRocaKr: asignar el KR a la roca", async () => {
    await goToRocasAsignar(page); // reabrir (el write anterior ya asentó su reload)
    const card = page.locator(".roca-card", { hasText: "Roca Fixture" });
    await card.click(); // expande la card (toggleRocaAsignar) -- no escribe nada, no hay reload que esperar
    await actionAndWaitForReload(page, () => card.getByText("KR Fixture", { exact: false }).click());
    await expect.poll(async () => (await getSpec(request)).rocas.find((r: any) => r.id === "r1").krIds)
      .toContain("k1");
  });

  await test.step("toggleRocaKr: desasignarlo de nuevo", async () => {
    await goToRocasAsignar(page);
    const card = page.locator(".roca-card", { hasText: "Roca Fixture" });
    await card.click();
    await actionAndWaitForReload(page, () => card.getByText("KR Fixture", { exact: false }).click());
    await expect.poll(async () => (await getSpec(request)).rocas.find((r: any) => r.id === "r1").krIds)
      .not.toContain("k1");
  });
});
