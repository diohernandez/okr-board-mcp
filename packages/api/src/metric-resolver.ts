// =============================================================================
// MetricResolver — resuelve el VALOR de una métrica gobernada (F1)
//
// Distinto de core's MetricCatalog.has() (que solo valida existencia, para el
// pipeline de escritura): esto resuelve el NÚMERO para mostrar en el board leído
// por el API. Vive acá, no en core, porque el pipeline de escritura nunca lo
// necesita — es un concern exclusivo de "armar la lectura resuelta del board".
//
// No lanza excepciones: una métrica que falla no debe tumbar toda la respuesta
// del board (con la migración progresiva literal->metric, cada vez va a haber
// más de estas). El caller decide qué hacer con { value: null, error }.
//
// Implementación MVP: snapshot local + cache TTL, mismo patrón que
// CachedMetricCatalog en core/src/metric-catalog.ts. Los valores son de DEMO,
// no cifras reales de BigQuery (ver data/metric-values-snapshot.json) — el día
// que haya una conexión en vivo a la capa semántica, se reemplaza esta clase por
// otra que implemente el mismo MetricResolver; el API no se entera.
// =============================================================================

import { readFile } from "node:fs/promises";

export interface MetricResolver {
  resolve(metric: string, filter?: Record<string, string>): Promise<{ value: number | null; error?: string }>;
}

export interface MetricValueSnapshot {
  fetched_at: string;
  source: string;
  values: Record<string, number>; // clave canónica, ver canonicalKey()
}

export interface MetricValueSnapshotLoader {
  load(): Promise<MetricValueSnapshot>;
}

export class FileMetricValueSnapshotLoader implements MetricValueSnapshotLoader {
  constructor(private filePath: string) {}
  async load(): Promise<MetricValueSnapshot> {
    const raw = await readFile(this.filePath, "utf8");
    return JSON.parse(raw) as MetricValueSnapshot;
  }
}

// metric+filter -> clave estable, sin importar el orden de las keys del filter ni
// mayúsculas/minúsculas en ningún lado (es una clave de cache interna, no un valor
// mostrado — no hace falta preservar el casing original de metric ni de filter).
function canonicalKey(metric: string, filter?: Record<string, string>): string {
  const base = metric.toUpperCase();
  if (!filter || Object.keys(filter).length === 0) return base;
  const parts = Object.keys(filter).sort().map(k => `${k.toUpperCase()}=${filter[k].toUpperCase()}`);
  return `${base}|${parts.join("&")}`;
}

export interface CachedMetricResolverOptions {
  ttlMs?: number;     // default 5 minutos, igual que CachedMetricCatalog
  now?: () => number; // inyectable para tests
}

export class SnapshotMetricResolver implements MetricResolver {
  private values: Map<string, number> | null = null;
  private loadedAt = -Infinity;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private loader: MetricValueSnapshotLoader, opts: CachedMetricResolverOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  async resolve(metric: string, filter?: Record<string, string>): Promise<{ value: number | null; error?: string }> {
    await this.ensureFresh();
    const key = canonicalKey(metric, filter);
    if (this.values!.has(key)) return { value: this.values!.get(key)! };
    return { value: null, error: `sin valor en el snapshot para '${key}'` };
  }

  private async ensureFresh(): Promise<void> {
    const nowMs = this.now();
    if (this.values && nowMs - this.loadedAt < this.ttlMs) return;
    const snapshot = await this.loader.load();
    this.values = new Map(Object.entries(snapshot.values).map(([k, v]) => [k.toUpperCase(), v]));
    this.loadedAt = nowMs;
  }
}
