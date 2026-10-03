#!/usr/bin/env node
import { openDb } from "./db";
import * as svc from "./service";
import { startServer } from "./api";
import { runDemo } from "./demo";

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

const USAGE = `DNA 阅读框分析 CLI
用法: node dist/src/cli.js <命令> [参数]

命令:
  serve [--port N]                     启动 HTTP API（默认自动选择空闲端口）
  import --name N [--sequence S | --file F]   导入序列（产生新版本）
  sequences                            列出序列版本
  analyze --sequence-version-id N [--min-protein-length N]
  analyses                             查看分析历史
  results --analysis-id N [--strand +|-] [--frame 0|1|2] [--min-protein-length N]
  codons --result-id N                 解释指定结果的密码子
  export --analysis-id N [--format json|fasta]   导出到项目 exports/ 目录
  demo                                 运行六框扫描演示
`;

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const db = openDb();
  switch (cmd) {
    case "serve": {
      const portFlag = argValue(args, "--port");
      const { port } = await startServer(portFlag ? Number(portFlag) : undefined);
      console.log(`API 已启动: http://127.0.0.1:${port}`);
      break;
    }
    case "import": {
      const name = argValue(args, "--name");
      let sequence = argValue(args, "--sequence");
      const file = argValue(args, "--file");
      if (!sequence && file) sequence = require("fs").readFileSync(file, "utf8");
      if (!name || !sequence) throw new svc.ApiError("BAD_REQUEST", "需要 --name 与 --sequence（或 --file）");
      printJson(svc.importSequence(db, name, sequence));
      break;
    }
    case "sequences":
      printJson(svc.listSequences(db));
      break;
    case "analyze": {
      const id = Number(argValue(args, "--sequence-version-id"));
      const min = argValue(args, "--min-protein-length");
      printJson(svc.createAnalysis(db, id, min ? Number(min) : undefined));
      break;
    }
    case "analyses":
      printJson(svc.listAnalyses(db));
      break;
    case "results": {
      const id = Number(argValue(args, "--analysis-id"));
      const strand = argValue(args, "--strand") as "+" | "-" | undefined;
      const frame = argValue(args, "--frame");
      const min = argValue(args, "--min-protein-length");
      printJson(svc.queryResults(db, id, {
        strand,
        frame: frame !== undefined ? Number(frame) : undefined,
        minProteinLength: min !== undefined ? Number(min) : undefined,
      }));
      break;
    }
    case "codons":
      printJson(svc.explainResult(db, Number(argValue(args, "--result-id"))));
      break;
    case "export": {
      const id = Number(argValue(args, "--analysis-id"));
      const format = argValue(args, "--format") ?? "json";
      const file = format === "fasta" ? svc.exportAnalysisFasta(db, id) : svc.exportAnalysisJson(db, id);
      console.log(`已导出: ${file}`);
      break;
    }
    case "demo":
      runDemo(db);
      break;
    default:
      process.stdout.write(USAGE);
      if (cmd) process.exitCode = 1;
  }
}

main().catch((err) => {
  if (err instanceof svc.ApiError || (err && err.code)) {
    console.error(`错误 [${err.code}]: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
