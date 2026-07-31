// =============================================================================
// MetricCatalog — adapter hacia el catálogo de métricas gobernadas (M2)
//
// El pipeline solo necesita has(metric): boolean (puerto MetricCatalog en
// pipeline.ts). Este archivo separa dos responsabilidades:
//   - un "loader" que sabe DÓNDE está el catálogo. Hoy: un snapshot JSON local
//     (data/metric-catalog.json), sembrado a mano contra get_data_context del
//     Analytics MCP. El día que la capa semántica exponga esto en vivo, se
//     reemplaza por otro loader — el pipeline no se entera (mismo puerto).
//   - un cache TTL delante del loader, para no releer/reconsultar en cada validación.
//
// El snapshot admite nombres exactos y prefijos: hay familias paramétricas (ej.
// GROSS_PROFIT_SIN_REFUSA_<canal>, CURRENT_STOCK_COST_<ubicación>_USD) donde
// enumerar cada combinación a mano sería frágil y quedaría desactualizado. has()
// hace match por prefijo para esos casos — falso positivo ahí es aceptable (el
// renderer/Analytics MCP rechaza en el resolve final); falso negativo bloquearía
// una edición legítima sin necesidad.
//
// has() es case-insensitive: los contratos usan ejemplos en minúscula ('nmv')
// pero el diccionario real usa mayúsculas (NMV) — normalizamos para no depender
// de qué convención termine ganando.
// =============================================================================

import { readFile } from "node:fs/promises";
import type { MetricCatalog } from "./pipeline";

export interface MetricSnapshot {
  fetched_at: string;
  source: string;
  exact: string[];
  prefixes: string[];
}

export interface MetricSnapshotLoader {
  load(): Promise<MetricSnapshot>;
}

export class FileMetricSnapshotLoader implements MetricSnapshotLoader {
  constructor(private filePath: string) {}
  async load(): Promise<MetricSnapshot> {
    const raw = await readFile(this.filePath, "utf8");
    return JSON.parse(raw) as MetricSnapshot;
  }
}

export interface CachedMetricCatalogOptions {
  ttlMs?: number;       // default 5 minutos
  now?: () => number;   // inyectable para tests
}

export class CachedMetricCatalog implements MetricCatalog {
  private exact: Set<string> | null = null;
  private prefixes: string[] = [];
  private loadedAt = -Infinity;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private loader: MetricSnapshotLoader, opts: CachedMetricCatalogOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  async has(metric: string): Promise<boolean> {
    await this.ensureFresh();
    const needle = metric.toUpperCase();
    if (this.exact!.has(needle)) return true;
    return this.prefixes.some(p => needle.startsWith(p.toUpperCase()));
  }

  // expuesto solo para diagnóstico (ej. un futuro tool de introspección); no es parte del puerto.
  async snapshotAge(): Promise<number> {
    await this.ensureFresh();
    return this.now() - this.loadedAt;
  }

  private async ensureFresh(): Promise<void> {
    const nowMs = this.now();
    if (this.exact && nowMs - this.loadedAt < this.ttlMs) return;
    const snapshot = await this.loader.load();
    this.exact = new Set(snapshot.exact.map(m => m.toUpperCase()));
    this.prefixes = snapshot.prefixes;
    this.loadedAt = nowMs;
  }
}
