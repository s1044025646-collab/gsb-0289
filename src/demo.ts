import { DatabaseSync } from "node:sqlite";
import * as svc from "./service";
import { reverseComplement } from "./sequence";

// 演示：六框扫描 + 负链来源解释
export function runDemo(db: DatabaseSync): void {
  const name = "demo-seq";
  const raw = "ATG AAA TAG CTA TTT CAT";
  console.log(`演示序列（含空白，将被清理）: ${raw}`);
  const sv = svc.importSequence(db, name, raw);
  console.log(`清理后: ${sv.cleaned} (长度 ${sv.length})`);
  console.log(`反向互补链: ${reverseComplement(sv.cleaned)}`);

  const analysis = svc.createAnalysis(db, sv.id, 1);
  console.log(`\n分析 #${analysis.id}: 状态=${analysis.status}, 完整 ORF=${analysis.result_count}, 未终止候选=${analysis.incomplete_count}`);

  const results = svc.queryResults(db, analysis.id);
  for (const r of results) {
    console.log(
      `  #${r.idx} 链=${r.strand} 框=${r.frame} 原坐标=[${r.start},${r.end}) ` +
      `nt=${r.ntLength} aa=${r.proteinLength} ${r.startCodon}→${r.stopCodon} 蛋白=${r.protein}`
    );
  }

  const minus = results.find((r) => r.strand === "-");
  if (minus) {
    console.log(`\n负链来源解释（结果 #${minus.idx}）:`);
    const { codons } = svc.explainResult(db, minus.id);
    for (const c of codons) {
      console.log(`  密码子 ${c.codonIndex}: ${c.codon} -> ${c.aminoAcid} (原序列 [${c.originalStart},${c.originalEnd}))`);
    }
    console.log("说明：负链 ORF 取自原序列的反向互补链，局部区间 [s,e) 已映射回原坐标 [L-e,L-s)。");
  }
  console.log("\n提示：本工具只做有限规则识别（ATG…同框终止），结果不代表真实表达基因。");
}
