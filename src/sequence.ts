export class SeqError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

// 清理规则（公开）：去除所有空白字符（空格、制表符、换行、回车等），统一转为大写。
// 只接受 A、C、G、T、N；其他字母（包括 RNA 的 U）与任何其他字符一律拒绝。
export function cleanSequence(raw: string): string {
  const cleaned = raw.replace(/\s+/g, "").toUpperCase();
  if (cleaned.length === 0) {
    throw new SeqError("EMPTY_SEQUENCE", "清理后序列为空");
  }
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch !== "A" && ch !== "C" && ch !== "G" && ch !== "T" && ch !== "N") {
      if (ch === "U") {
        throw new SeqError(
          "INVALID_SEQUENCE_CHAR",
          `位置 ${i} 出现 'U'：本服务只接受 DNA（A/C/G/T/N），拒绝 RNA 碱基 U`
        );
      }
      throw new SeqError(
        "INVALID_SEQUENCE_CHAR",
        `位置 ${i} 出现非法字符 '${ch}'：只允许 A/C/G/T/N`
      );
    }
  }
  return cleaned;
}

const COMPLEMENT: Record<string, string> = { A: "T", T: "A", C: "G", G: "C", N: "N" };

export function reverseComplement(seq: string): string {
  let out = "";
  for (let i = seq.length - 1; i >= 0; i--) {
    out += COMPLEMENT[seq[i]];
  }
  return out;
}
