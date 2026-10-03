import path from "node:path";
import { readFileSync } from "node:fs";
import { Db } from "./db.js";
import { startServer } from "./api.js";
import { scanSixFrames } from "./orf.js";
import { cleanSequence, reverseComplement } from "./sequence.js";

const DATA_DIR = process.env.ORF_DATA_DIR ?? path.join(process.cwd(), "data");
const EXPORT_DIR = process.env.ORF_EXPORT_DIR ?? path.join(process.cwd(), "exports");

function usage(): void {
  console.log(`DNA 开放阅读框分析 CLI
用法: node dist/src/cli.js <命令> [参数]

命令:
  serve [--port N]                     启动 HTTP API（默认自动选择空闲端口）
  import <name> <sequence|@file>       导入序列（同名产生新版本）
  analyze <sequenceId> [minProteinLen] 创建分析
  results <analysisId> [+|-] [minLen]  查询结果（可按链和最短蛋白长度过滤）
  explain <analysisId> <+|-> <0|1|2>   解释指定阅读框的密码子
  history                              查看分析历史
  export <analysisId> <json|fasta>     导出到项目 exports 目录
  demo                                 六框扫描演示（含负链来源解释）
`);
}

function openDb(): Db {
  return new Db(DATA_DIR);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "serve": {
      const portIdx = args.indexOf("--port");
      const port = portIdx >= 0 ? Number(args[portIdx + 1]) : Number(process.env.PORT ?? 0);
      const db = openDb();
      const { port: actual } = await startServer(db, EXPORT_DIR, port);
      console.log(`API 已启动: http://127.0.0.1:${actual}  (数据目录: ${DATA_DIR})`);
      break;
    }
    case "import": {
      const [name, seqArg] = args;
      if (!name || !seqArg) return usage();
      const raw = seqArg.startsWith("@") ? readFileSync(seqArg.slice(1), "utf8") : seqArg;
      const db = openDb();
      const row = db.importSequence(name, raw);
      console.log(JSON.stringify(row, null, 2));
      db.close();
      break;
    }
    case "analyze": {
      const db = openDb();
      const { analysis, results } = db.createAnalysis(Number(args[0]), args[1] ? Number(args[1]) : 1);
      console.log(JSON.stringify({ ...analysis, results }, null, 2));
      db.close();
      break;
    }
    case "results": {
      const db = openDb();
      const filter: Record<string, unknown> = {};
      if (args[1]) filter.strand = args[1];
      if (args[2]) filter.minProteinLength = Number(args[2]);
      console.log(JSON.stringify(db.queryResults(Number(args[0]), filter), null, 2));
      db.close();
      break;
    }
    case "explain": {
      const db = openDb();
      const analysis = db.getAnalysis(Number(args[0]));
      const seq = db.getSequence(analysis.sequence_id);
      const strand = args[1] as "+" | "-";
      const offset = Number(args[2]);
      const oriented = strand === "+" ? seq.cleaned_sequence : reverseComplement(seq.cleaned_sequence);
      console.log(`分析 ${args[0]} 链 ${strand} 偏移 ${offset}${strand === "-" ? "（来自反向互补链）" : ""}`);
      for (let i = offset; i + 3 <= oriented.length; i += 3) {
        const codon = oriented.slice(i, i + 3);
        const tag = codon === "ATG" ? " [起始]" : ["TAA", "TAG", "TGA"].includes(codon) ? " [终止]" : "";
        console.log(`  局部 ${i}-${i + 3}: ${codon}${tag}`);
      }
      db.close();
      break;
    }
    case "history": {
      const db = openDb();
      console.log(JSON.stringify(db.listAnalyses(), null, 2));
      db.close();
      break;
    }
    case "export": {
      const db = openDb();
      const { port, close } = await startServer(db, EXPORT_DIR, 0);
      const res = await fetch(`http://127.0.0.1:${port}/analyses/${args[0]}/export/${args[1]}`, { method: "POST" });
      console.log(JSON.stringify(await res.json(), null, 2));
      close();
      db.close();
      break;
    }
    case "demo": {
      demo();
      break;
    }
    default:
      usage();
  }
}

function demo(): void {
  const seq = cleanSequence("CCATGAAATAGGGCTATTTCATGG");
  console.log(`演示序列（清理后）: ${seq}  长度 ${seq.length}`);
  console.log("规则：六框扫描，ATG 起始，同框第一个 TAA/TAG/TGA 结束；负链取自反向互补序列。\n");
  const { results, unterminatedCount } = scanSixFrames(seq, 1);
  for (const r of results) {
    const src = r.strand === "-" ? "反向互补链，坐标已映射回原序列" : "正链";
    console.log(
      `链 ${r.strand} 框 ${r.frameOffset} [${r.start},${r.end}) nt=${r.ntLength} aa=${r.proteinLength} ` +
        `${r.startCodon}..${r.stopCodon} 蛋白=${r.protein}  （${src}）`,
    );
  }
  console.log(`\n未终止候选（到末端仍无同框终止子，不计入完整结果）: ${unterminatedCount}`);
}

main().catch((err) => {
  console.error(err.code ? `[${err.code}] ${err.message}` : err);
  process.exit(1);
});
