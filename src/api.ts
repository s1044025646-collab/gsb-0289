import http from "http";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "./db";
import * as svc from "./service";
import { SeqError } from "./sequence";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof svc.ApiError) {
    sendJson(res, err.httpStatus, { error: { code: err.code, message: err.message } });
  } else if (err instanceof SeqError) {
    sendJson(res, 400, { error: { code: err.code, message: err.message } });
  } else {
    sendJson(res, 500, { error: { code: "INTERNAL", message: String(err) } });
  }
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new svc.ApiError("BAD_REQUEST", "请求体必须是合法 JSON");
  }
}

export function createServer(db: DatabaseSync): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && parts.length === 0) {
        return sendJson(res, 200, {
          service: "dna-orf-finder",
          endpoints: [
            "POST /sequences {name, sequence}",
            "GET /sequences",
            "POST /analyses {sequenceVersionId, minProteinLength?}",
            "GET /analyses",
            "GET /analyses/:id",
            "GET /analyses/:id/results?strand=+|-&frame=0|1|2&minProteinLength=n",
            "GET /results/:id/codons",
            "POST /analyses/:id/export?format=json|fasta",
          ],
        });
      }

      if (method === "POST" && parts[0] === "sequences" && parts.length === 1) {
        const body = await readBody(req);
        if (typeof body.name !== "string" || typeof body.sequence !== "string") {
          throw new svc.ApiError("BAD_REQUEST", "需要字符串字段 name 与 sequence");
        }
        return sendJson(res, 201, svc.importSequence(db, body.name, body.sequence));
      }
      if (method === "GET" && parts[0] === "sequences" && parts.length === 1) {
        return sendJson(res, 200, svc.listSequences(db));
      }

      if (method === "POST" && parts[0] === "analyses" && parts.length === 1) {
        const body = await readBody(req);
        if (!Number.isInteger(body.sequenceVersionId)) {
          throw new svc.ApiError("BAD_REQUEST", "需要整数字段 sequenceVersionId");
        }
        return sendJson(res, 201, svc.createAnalysis(db, body.sequenceVersionId, body.minProteinLength));
      }
      if (method === "GET" && parts[0] === "analyses" && parts.length === 1) {
        return sendJson(res, 200, svc.listAnalyses(db));
      }
      if (method === "GET" && parts[0] === "analyses" && parts.length === 2) {
        return sendJson(res, 200, svc.getAnalysis(db, Number(parts[1])));
      }
      if (method === "GET" && parts[0] === "analyses" && parts[2] === "results" && parts.length === 3) {
        const q = url.searchParams;
        return sendJson(res, 200, svc.queryResults(db, Number(parts[1]), {
          strand: (q.get("strand") as "+" | "-") ?? undefined,
          frame: q.has("frame") ? Number(q.get("frame")) : undefined,
          minProteinLength: q.has("minProteinLength") ? Number(q.get("minProteinLength")) : undefined,
        }));
      }
      if (method === "POST" && parts[0] === "analyses" && parts[2] === "export" && parts.length === 3) {
        const format = url.searchParams.get("format") ?? "json";
        const file = format === "fasta"
          ? svc.exportAnalysisFasta(db, Number(parts[1]))
          : svc.exportAnalysisJson(db, Number(parts[1]));
        return sendJson(res, 200, { file });
      }
      if (method === "GET" && parts[0] === "results" && parts[2] === "codons" && parts.length === 3) {
        return sendJson(res, 200, svc.explainResult(db, Number(parts[1])));
      }

      throw new svc.ApiError("NOT_FOUND", `未匹配的路由：${method} ${url.pathname}`, 404);
    } catch (err) {
      sendError(res, err);
    }
  });
}

export function startServer(port?: number): Promise<{ server: http.Server; port: number }> {
  const db = openDb();
  const server = createServer(db);
  const requested = port ?? (process.env.PORT ? Number(process.env.PORT) : 0); // 默认选择空闲端口
  return new Promise((resolve) => {
    server.listen(requested, "127.0.0.1", () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : requested;
      resolve({ server, port: actual });
    });
  });
}
