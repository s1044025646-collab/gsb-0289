import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Db, NotFoundError } from "./db.js";
import { SequenceError, reverseComplement } from "./sequence.js";
import { isStopCodon, translateCodon } from "./geneticCode.js";

interface Ctx {
  db: Db;
  exportDir: string;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

function sendError(res: http.ServerResponse, status: number, code: string, message: string, details?: unknown): void {
  send(res, status, { error: { code, message, details } });
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new SequenceError("INVALID_JSON", "请求体不是合法 JSON");
  }
}

function fastaExport(analysisId: number, rows: Record<string, unknown>[]): string {
  const lines: string[] = [];
  for (const r of rows) {
    lines.push(
      `>orf_${analysisId}_${r.result_index} strand=${r.strand} coords=${r.start}-${r.end} frame=${r.frame_offset} len_aa=${r.protein_length}`,
    );
    const protein = String(r.protein);
    for (let i = 0; i < protein.length; i += 60) lines.push(protein.slice(i, i + 60));
  }
  return lines.join("\n") + "\n";
}

function explainFrame(db: Db, analysisId: number, strand: string, offset: number): unknown {
  const analysis = db.getAnalysis(analysisId);
  const seq = db.getSequence(analysis.sequence_id);
  if (strand !== "+" && strand !== "-") {
    throw new SequenceError("INVALID_PARAMS", "strand 只能是 + 或 -");
  }
  if (![0, 1, 2].includes(offset)) {
    throw new SequenceError("INVALID_PARAMS", "frameOffset 必须是 0、1 或 2");
  }
  const oriented = strand === "+" ? seq.cleaned_sequence : reverseComplement(seq.cleaned_sequence);
  const L = seq.cleaned_sequence.length;
  const codons = [];
  for (let i = 0; i + 3 <= oriented.length; i += 3) {
    const codon = oriented.slice(i, i + 3);
    codons.push({
      codonIndex: (i - offset) / 3,
      localStart: i,
      origStart: strand === "+" ? i : L - (i + 3),
      origEnd: strand === "+" ? i + 3 : L - i,
      codon,
      aminoAcid: translateCodon(codon),
      isStart: codon === "ATG",
      isStop: isStopCodon(codon),
    });
  }
  return {
    analysisId,
    sequenceId: seq.id,
    strand,
    frameOffset: offset,
    note: strand === "-" ? "负链密码子来自原序列的反向互补链，origStart/origEnd 已映射回原序列坐标" : "正链密码子坐标即原序列坐标",
    trailingBases: (oriented.length - offset) % 3,
    codons,
  };
}

export function createServer(db: Db, exportDir: string): http.Server {
  mkdirSync(exportDir, { recursive: true });
  const ctx: Ctx = { db, exportDir };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";
    try {
      if (method === "GET" && url.pathname === "/") {
        return send(res, 200, {
          service: "dna-orf-finder",
          endpoints: [
            "POST /sequences {name, sequence}",
            "GET /sequences",
            "GET /sequences/:id",
            "POST /analyses {sequenceId, minProteinLength?, maxResults?}",
            "GET /analyses",
            "GET /analyses/:id",
            "GET /analyses/:id/results?strand=&minProteinLength=&frameOffset=",
            "GET /analyses/:id/frames/:strand/:offset",
            "POST /analyses/:id/export/json",
            "POST /analyses/:id/export/fasta",
          ],
        });
      }

      if (parts[0] === "sequences") {
        if (method === "POST" && parts.length === 1) {
          const body = (await readBody(req)) as Record<string, unknown>;
          const row = ctx.db.importSequence(String(body.name ?? ""), String(body.sequence ?? ""));
          return send(res, 201, row);
        }
        if (method === "GET" && parts.length === 1) {
          return send(res, 200, ctx.db.listSequences());
        }
        if (method === "GET" && parts.length === 2) {
          return send(res, 200, ctx.db.getSequence(Number(parts[1])));
        }
      }

      if (parts[0] === "analyses") {
        if (method === "POST" && parts.length === 1) {
          const body = (await readBody(req)) as Record<string, unknown>;
          const { analysis, results } = ctx.db.createAnalysis(
            Number(body.sequenceId),
            body.minProteinLength === undefined ? 1 : Number(body.minProteinLength),
            body.maxResults === undefined ? undefined : Number(body.maxResults),
          );
          return send(res, 201, { ...analysis, results });
        }
        if (method === "GET" && parts.length === 1) {
          return send(res, 200, ctx.db.listAnalyses());
        }
        const id = Number(parts[1]);
        if (method === "GET" && parts.length === 2) {
          return send(res, 200, ctx.db.getAnalysis(id));
        }
        if (method === "GET" && parts[2] === "results") {
          const q = url.searchParams;
          const filter: Record<string, unknown> = {};
          if (q.has("strand")) filter.strand = q.get("strand");
          if (q.has("minProteinLength")) filter.minProteinLength = Number(q.get("minProteinLength"));
          if (q.has("frameOffset")) filter.frameOffset = Number(q.get("frameOffset"));
          return send(res, 200, ctx.db.queryResults(id, filter));
        }
        if (method === "GET" && parts[2] === "frames" && parts.length === 5) {
          return send(res, 200, explainFrame(ctx.db, id, parts[3], Number(parts[4])));
        }
        if (method === "POST" && parts[2] === "export" && parts.length === 4) {
          const analysis = ctx.db.getAnalysis(id);
          const rows = ctx.db.queryResults(id) as Record<string, unknown>[];
          const format = parts[3];
          let file: string;
          let content: string;
          if (format === "json") {
            file = path.join(ctx.exportDir, `analysis_${id}.json`);
            content = JSON.stringify({ analysis, results: rows }, null, 2);
          } else if (format === "fasta") {
            file = path.join(ctx.exportDir, `analysis_${id}.fasta`);
            content = fastaExport(id, rows);
          } else {
            throw new SequenceError("INVALID_PARAMS", "导出格式只支持 json 或 fasta");
          }
          writeFileSync(file, content, "utf8");
          return send(res, 200, { exported: file, resultCount: rows.length });
        }
      }

      sendError(res, 404, "NOT_FOUND", `路由不存在: ${method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof NotFoundError) {
        sendError(res, 404, err.code, err.message);
      } else if (err instanceof SequenceError) {
        sendError(res, 400, err.code, err.message, err.details);
      } else {
        sendError(res, 500, "INTERNAL_ERROR", String(err));
      }
    }
  });
}

export function startServer(db: Db, exportDir: string, port = 0): Promise<{ port: number; close: () => void }> {
  const server = createServer(db, exportDir);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({ port: actualPort, close: () => server.close() });
    });
  });
}
