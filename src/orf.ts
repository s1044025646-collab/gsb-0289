import { START_CODON, isStop, translate } from "./geneticCode";
import { reverseComplement } from "./sequence";

export type Strand = "+" | "-";

export interface OrfRecord {
  strand: Strand;
  frame: number; // 被扫描链上的阅读框偏移 0/1/2
  start: number; // 原始清理后序列上的零基半开区间 [start, end)
  end: number;
  ntLength: number; // 含终止密码子
  proteinLength: number; // 不含终止密码子
  startCodon: string;
  stopCodon: string;
  protein: string;
}

export interface ScanResult {
  orfs: OrfRecord[];
  incompleteCount: number; // 到末端仍未遇到同框终止密码子的候选数
}

function scanStrand(seq: string, strand: Strand, originalLength: number, minProteinLength: number, result: OrfRecord[]): number {
  let incomplete = 0;
  const len = seq.length;
  for (let frame = 0; frame < 3; frame++) {
    // 预计算每个同框位置的下一个终止密码子位置（无则为 -1）
    const nextStop = new Map<number, number>();
    let next = -1;
    for (let i = len - 3 - ((len - 3 - frame) % 3); i >= frame; i -= 3) {
      const codon = seq.slice(i, i + 3);
      if (isStop(codon)) next = i;
      nextStop.set(i, next);
    }
    for (let i = frame; i + 3 <= len; i += 3) {
      if (seq.slice(i, i + 3) !== START_CODON) continue;
      const stop = nextStop.get(i)!;
      if (stop < 0) {
        incomplete++; // 未终止候选：单独统计，不伪装成完整结果
        continue;
      }
      const localStart = i;
      const localEnd = stop + 3; // 核酸区间包含终止密码子
      const protein = translate(seq.slice(localStart, stop)); // 蛋白含起始 M，不含终止符
      if (protein.length < minProteinLength) continue;
      // 负链局部区间 [s,e) 映射为 [L-e, L-s)
      const start = strand === "+" ? localStart : originalLength - localEnd;
      const end = strand === "+" ? localEnd : originalLength - localStart;
      result.push({
        strand,
        frame,
        start,
        end,
        ntLength: localEnd - localStart,
        proteinLength: protein.length,
        startCodon: START_CODON,
        stopCodon: seq.slice(stop, stop + 3),
        protein,
      });
    }
  }
  return incomplete;
}

// 六框扫描：正链三个偏移 + 反向互补链三个偏移。
// 输出顺序固定：先正链 frame 0/1/2，再负链 frame 0/1/2，各自按位置升序；不按蛋白合并。
export function scanOrfs(cleaned: string, minProteinLength: number): ScanResult {
  const orfs: OrfRecord[] = [];
  let incomplete = 0;
  incomplete += scanStrand(cleaned, "+", cleaned.length, minProteinLength, orfs);
  incomplete += scanStrand(reverseComplement(cleaned), "-", cleaned.length, minProteinLength, orfs);
  return { orfs, incompleteCount: incomplete };
}
