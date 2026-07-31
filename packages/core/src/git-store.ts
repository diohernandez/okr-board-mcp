// =============================================================================
// GitSpecStore — implementación del puerto SpecStore sobre git (MVP)
//
// Guarda cada documento como <dataDir>/<docId>.json en un repo git. Cada commit
// es una versión: git da historial, diff y rollback gratis. El "token de versión"
// es el sha del blob del archivo en HEAD (content-addressed): cambia si y solo si
// cambia el contenido, y es independiente por documento (no hay conflictos falsos
// entre docs).
//
// Concurrencia optimista + atomicidad:
//   - readHead devuelve el sha del blob en HEAD.
//   - commit serializa las escrituras en proceso (mutex) y RE-VERIFICA que el HEAD
//     del archivo siga siendo expectedVersion justo antes de commitear; si cambió,
//     lanza ConcurrencyError. El MCP es un solo proceso, así que el mutex hace
//     atómico el check+commit. (Multi-proceso: agregar un lock de archivo — flock.)
//
// Cuando pasemos a Postgres en la versión final, esto se reemplaza por otra clase
// que implemente el mismo puerto SpecStore. El pipeline no se entera.
// =============================================================================

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ConcurrencyError, NotFoundError, type OkrBoardSpec, type SpecStore } from "./pipeline";

const execFileAsync = promisify(execFile);
const SLUG = /^[A-Za-z0-9_-]+$/;

export interface GitSpecStoreOptions {
  repoDir: string;                              // ruta al repo git
  dataDir?: string;                             // subdir de specs dentro del repo (default: "data")
  committer?: { name: string; email: string }; // identidad del bot que firma los commits
}

export class GitSpecStore implements SpecStore {
  private readonly repoDir: string;
  private readonly dataDir: string;
  private readonly committer: { name: string; email: string };
  private queue: Promise<unknown> = Promise.resolve(); // mutex en proceso

  constructor(opts: GitSpecStoreOptions) {
    this.repoDir = opts.repoDir;
    this.dataDir = opts.dataDir ?? "data";
    this.committer = opts.committer ?? { name: "okr-board-mcp", email: "mcp@bidcom.local" };
  }

  // --- lectura ---
  async readHead(docId: string): Promise<{ spec: OkrBoardSpec; version: string }> {
    const rel = this.relPath(docId);
    const version = await this.blobSha(rel);
    if (version === null) throw new NotFoundError(`documento no encontrado: ${docId}`);
    const raw = await this.gitRaw(["show", `HEAD:${rel}`]);
    return { spec: JSON.parse(raw) as OkrBoardSpec, version };
  }

  // --- escritura (concurrencia optimista + atomicidad por mutex) ---
  async commit(docId: string, spec: OkrBoardSpec, message: string, expectedVersion: string): Promise<string> {
    const rel = this.relPath(docId);
    return this.serialize(async () => {
      const current = await this.blobSha(rel);
      if (current !== expectedVersion) {
        throw new ConcurrencyError(
          `base_version desactualizada para ${docId}: HEAD=${current ?? "(inexistente)"}, recibí ${expectedVersion}`);
      }
      const desired = this.serializeSpec(spec);
      const currentRaw = await this.gitRaw(["show", `HEAD:${rel}`]);
      if (currentRaw === desired) return expectedVersion; // no-op: mismo contenido, no commiteamos
      await this.writeAndCommit(rel, desired, message);
      return (await this.blobSha(rel))!;
    });
  }

  // --- bootstrap (M5): crear un documento nuevo. No es parte del puerto SpecStore. ---
  async init(docId: string, spec: OkrBoardSpec, message?: string): Promise<string> {
    const rel = this.relPath(docId);
    return this.serialize(async () => {
      if ((await this.blobSha(rel)) !== null) throw new Error(`el documento ya existe: ${docId}`);
      await this.writeAndCommit(rel, this.serializeSpec(spec), message ?? `init ${docId}`);
      return (await this.blobSha(rel))!;
    });
  }

  // --- internos ---
  private relPath(docId: string): string {
    if (!SLUG.test(docId)) throw new Error(`docId inválido (previene path traversal): ${docId}`);
    return join(this.dataDir, `${docId}.json`);
  }

  private serializeSpec(spec: OkrBoardSpec): string {
    return JSON.stringify(spec, null, 2) + "\n"; // 2 espacios + newline final = diffs limpios
  }

  // sha del blob del archivo en HEAD, o null si no existe / no hay HEAD todavía
  private async blobSha(rel: string): Promise<string | null> {
    try { return await this.git(["rev-parse", `HEAD:${rel}`]); }
    catch { return null; }
  }

  private async writeAndCommit(rel: string, content: string, message: string): Promise<void> {
    const abs = join(this.repoDir, rel);
    await mkdir(join(this.repoDir, this.dataDir), { recursive: true });
    await writeFile(abs, content, "utf8");
    await this.git(["add", "--", rel]);
    await this.git([
      "-c", `user.name=${this.committer.name}`,
      "-c", `user.email=${this.committer.email}`,
      "commit", "-m", message, "--", rel,
    ]);
  }

  // ejecuta git con args en array (sin shell -> sin inyección); devuelve stdout trimmeado
  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", ["-C", this.repoDir, ...args], {
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout.trim();
  }

  // igual que git() pero sin trim (para leer contenido de archivos verbatim)
  private async gitRaw(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", ["-C", this.repoDir, ...args], {
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout;
  }

  // serializa todas las escrituras en proceso: hace atómico el check+commit
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => fn());
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
