// =============================================================================
// serve-frontend (F2) — estático para apps/frontend, proceso separado del API
//
// A propósito NO es el mismo proceso que packages/api: "aunque compartan repo,
// son dos procesos en dos lugares" (principio del plan de monorepo) — acá se
// rehearsa esa frontera incluso en local. apps/frontend llama al API real por
// HTTP (ver API_BASE en index.html); este server solo sirve los archivos estáticos.
// =============================================================================

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
async function repoRoot(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"]);
  return stdout.trim();
}

const PORT = Number(process.env.PORT ?? 8789);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

async function main() {
  const ROOT = await repoRoot();
  const FRONTEND_DIR = join(ROOT, "apps", "frontend");

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
      const rel = normalize(pathname).replace(/^([.][.][/\\])+/, "");
      const filePath = join(FRONTEND_DIR, rel);
      if (!filePath.startsWith(FRONTEND_DIR)) { res.writeHead(400); res.end("bad path"); return; }

      const body = await readFile(filePath);
      res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
      res.end(body);
    } catch (e) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`no encontrado: ${(e as Error).message}`);
    }
  });

  server.listen(PORT, () => {
    console.log(`okr-board-frontend: http://localhost:${PORT}/  (sirve ${FRONTEND_DIR})`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
