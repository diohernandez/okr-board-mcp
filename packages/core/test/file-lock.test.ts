import { mkdtemp, rm, writeFile, utimes, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../src/file-lock";

let pass = 0, fail = 0;
const ok = (c: boolean, l: string) => c ? (pass++, console.log("OK  " + l)) : (fail++, console.log("FALLO  " + l));

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "file-lock-"));

  // 1. happy: corre fn, devuelve su resultado, y libera el lock (no queda el archivo)
  {
    const lock = join(dir, "a.lock");
    const result = await withFileLock(lock, async () => 42);
    ok(result === 42, "withFileLock devuelve el resultado de fn()");
    ok(!(await exists(lock)), "withFileLock libera el lock al terminar (no queda el archivo)");
  }

  // 2. excepción en fn(): el lock se libera igual (finally)
  {
    const lock = join(dir, "b.lock");
    await withFileLock(lock, async () => { throw new Error("boom"); }).catch(() => {});
    ok(!(await exists(lock)), "si fn() tira, el lock se libera igual (no queda colgado)");
    // si de verdad se liberó, un segundo intento debe entrar sin esperar el timeout
    const t0 = Date.now();
    await withFileLock(lock, async () => {}, { timeoutMs: 2000 });
    ok(Date.now() - t0 < 500, "confirmado: el segundo withFileLock entró rápido, no esperó timeout");
  }

  // 3. contención real: dos llamadas concurrentes sobre el MISMO lock nunca corren
  // fn() al mismo tiempo (una espera a que la otra termine y libere).
  {
    const lock = join(dir, "c.lock");
    let inside = 0, sawOverlap = false;
    const worker = () => withFileLock(lock, async () => {
      inside++;
      if (inside > 1) sawOverlap = true;
      await new Promise((r) => setTimeout(r, 100));
      inside--;
    });
    await Promise.all([worker(), worker(), worker()]);
    ok(!sawOverlap, "contención: nunca hay dos fn() corriendo a la vez sobre el mismo lock");
  }

  // 4. lock viejo (holder "crasheado") se considera abandonado y se rompe, no cuelga
  {
    const lock = join(dir, "d.lock");
    await writeFile(lock, "99999\n");
    const old = new Date(Date.now() - 60_000); // 60s atrás
    await utimes(lock, old, old);
    const t0 = Date.now();
    const result = await withFileLock(lock, async () => "recuperado", { staleMs: 5_000, timeoutMs: 3_000 });
    ok(result === "recuperado", "lock viejo (>staleMs): se rompe y withFileLock sigue adelante");
    ok(Date.now() - t0 < 1_000, "lock viejo: no esperó el timeout completo, lo detectó como stale enseguida");
  }

  // 5. lock fresco y nunca liberado -> timeout limpio (no cuelga para siempre)
  {
    const lock = join(dir, "e.lock");
    await writeFile(lock, "99999\n"); // fresco: mtime = ahora
    let threw = false;
    try { await withFileLock(lock, async () => {}, { staleMs: 60_000, timeoutMs: 300, retryMs: 20 }); }
    catch { threw = true; }
    ok(threw, "lock fresco nunca liberado: withFileLock tira por timeout en vez de colgarse");
    await rm(lock, { force: true });
  }

  console.log(`\n${pass} OK · ${fail} FALLO`);
  await rm(dir, { recursive: true, force: true });
  if (fail) process.exit(1);
}

main();
