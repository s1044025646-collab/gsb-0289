import { isStopCodon, translateNt } from "./geneticCode.js";
import { reverseComplement } from "./sequence.js";

export type Strand = "+" | "-";

export interface OrfResult {
  strand: Strand;
  frameOffset: number; // 被扫描链上的 0/1/2 偏移
  start: number; // 原序列零基半开坐标 [start, end)，含终止密码子
  end: number;
  ntLength: number; // 含终止密码子
  proteinLength: number; // 含起始甲硫氨酸，不含终止符
  startCodon: string;
  stopCodon: string;
  protein: string;
}

export interface ScanOutput {
  results: OrfResult[];
  unterminatedCount: number; // 到末端仍未遇到同框终止密码子的 ATG 候选数
  truncated: boolean; // 结果数达到上限被截断
  totalCandidateCount: number; // 完整 ORF 候选总数（截断前）
}

export const DEFAULT_MAX_RESULTS = 100_000;

// 六框扫描：正链偏移 0/1/2，反向互补链偏移 0/1/2。
// 每个同框 ATG 都是独立候选起点，遇到同框第一个终止密码子结束（嵌套 ATG 各自产出）。
// 末端不足 3 碱基的残片被丢弃，不拼接到其他阅读框。
export function scanSixFrames(
  cleaned: string,
  minProteinLength: number,
  maxResults: number = DEFAULT_MAX_RESULTS,
): ScanOutput {
  const results: OrfResult[] = [];
  let unterminatedCount = 0;
  let totalCandidateCount = 0;
  let truncated = false;
  const L = cleaned.length;

  outer: for (const strand of ["+", "-"] as Strand[]) {
    const seq = strand === "+" ? cleaned : reverseComplement(cleaned);
    for (let offset = 0; offset < 3; offset++) {
      const pendingAtgs: number[] = [];
      for (let i = offset; i + 3 <= seq.length; i += 3) {
        const codon = seq.slice(i, i + 3);
        if (codon === "ATG") {
          pendingAtgs.push(i);
        } else if (isStopCodon(codon)) {
          for (const s of pendingAtgs) {
            totalCandidateCount++;
            const e = i + 3; // 局部坐标，含终止密码子
            const protein = translateNt(seq.slice(s, i));
            if (protein.length >= minProteinLength) {
              if (results.length >= maxResults) {
                truncated = true;
                break outer;
              }
              const start = strand === "+" ? s : L - e;
              const end = strand === "+" ? e : L - s;
              results.push({
                strand,
                frameOffset: offset,
                start,
                end,
                ntLength: e - s,
                proteinLength: protein.length,
                startCodon: "ATG",
                stopCodon: codon,
                protein,
              });
            }
          }
          pendingAtgs.length = 0;
        }
      }
      unterminatedCount += pendingAtgs.length;
    }
  }
  return { results, unterminatedCount, truncated, totalCandidateCount };
}

// 从报告坐标直接切片复原蛋白，用于测试核对坐标一致性。
export function proteinFromReportCoords(cleaned: string, r: Pick<OrfResult, "strand" | "start" | "end">): string {
  const slice = cleaned.slice(r.start, r.end);
  const oriented = r.strand === "+" ? slice : reverseComplement(slice);
  return translateNt(oriented.slice(0, oriented.length - 3));
}
