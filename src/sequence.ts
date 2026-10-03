// 序列清理与校验。公开规则：
// 1) 删除所有空白字符（空格、制表符、换行、回车等 \s）；
// 2) 全部转为大写；
// 3) 只允许 A、C、G、T、N；RNA 的 U 与其他任何字符一律拒绝。
export class SequenceError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const MAX_SEQUENCE_LENGTH = 1_000_000;

export function cleanSequence(raw: string): string {
  if (typeof raw !== "string") {
    throw new SequenceError("INVALID_PARAMS", "sequence 必须是字符串");
  }
  const cleaned = raw.replace(/\s+/g, "").toUpperCase();
  if (cleaned.length === 0) {
    throw new SequenceError("EMPTY_SEQUENCE", "清理后序列为空");
  }
  if (cleaned.length > MAX_SEQUENCE_LENGTH) {
    throw new SequenceError(
      "SEQUENCE_TOO_LONG",
      `序列长度 ${cleaned.length} 超过上限 ${MAX_SEQUENCE_LENGTH}`,
    );
  }
  const bad = cleaned.match(/[^ACGTN]/g);
  if (bad) {
    const uniq = [...new Set(bad)];
    if (uniq.includes("U")) {
      throw new SequenceError(
        "RNA_NOT_SUPPORTED",
        "检测到 RNA 碱基 U，本服务只接受 DNA（A/C/G/T/N）",
        { invalidChars: uniq },
      );
    }
    throw new SequenceError(
      "INVALID_SEQUENCE_CHAR",
      `序列包含非法字符: ${uniq.join(", ")}`,
      { invalidChars: uniq },
    );
  }
  return cleaned;
}

const COMPLEMENT: Record<string, string> = { A: "T", T: "A", C: "G", G: "C", N: "N" };

export function reverseComplement(seq: string): string {
  let rc = "";
  for (let i = seq.length - 1; i >= 0; i--) {
    rc += COMPLEMENT[seq[i]];
  }
  return rc;
}
