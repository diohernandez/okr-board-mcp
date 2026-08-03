// =============================================================================
// file-lock — primitiva de exclusión mutua ENTRE PROCESOS, sin dependencias nuevas.
//
// GitSpecStore ya serializa las escrituras EN PROCESO (this.queue, ver git-store.ts).
// Eso alcanza mientras el único escritor sea el servidor MCP. El día que un segundo
// proceso escriba al mismo repo (F4: el API aceptando writes), la ventana entre
// "leer HEAD" y "commitear" deja de ser atómica entre procesos — dos escrituras
// pueden interlearse ahí sin que ninguna vea el cambio de la otra, o los subprocesos
// de `git` de cada proceso pueden pisarse en .git/index.lock (un error crudo de git,
// no un ConcurrencyError limpio).
//
// open(path, "wx") es atómico (falla con EEXIST si el archivo ya existe) — el mismo
// primitivo que usan las implementaciones de lockfile más usadas, sin traer una
// dependencia para algo de ~30 líneas. Maneja el caso de un holder que crasheó sin
// liberar el lock (staleMs) y un timeout para no colgarse para siempre.
// =============================================================================

import { open, unlink, stat } from "node:fs/promises";

export interface FileLockOptions {
  staleMs?: number;   // lock más viejo que esto se asume abandonado (holder crasheado)
  retryMs?: number;   // intervalo de reintento mientras se espera
  timeoutMs?: number;  // tiempo máximo de espera antes de rendirse
}

async function isStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > staleMs;
  } catch {
    return true; // el lock desapareció entre el EEXIST y este stat: tratarlo como libre
  }
}

async function acquire(lockPath: string, opts: FileLockOptions): Promise<void> {
  const staleMs = opts.staleMs ?? 30_000;
  const retryMs = opts.retryMs ?? 50;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const fh = await open(lockPath, "wx");
      try { await fh.writeFile(`${process.pid}\n`); } finally { await fh.close(); }
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (await isStale(lockPath, staleMs)) {
        await unlink(lockPath).catch(() => {}); // best-effort: si alguien más ya lo limpió, seguir
        continue;
      }
      if (Date.now() > deadline) throw new Error(`no se pudo tomar el lock ${lockPath} (timeout ${timeoutMs}ms)`);
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

// Corre fn() con el lock tomado; lo libera siempre, incluso si fn() tira.
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, opts: FileLockOptions = {}): Promise<T> {
  await acquire(lockPath, opts);
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}
