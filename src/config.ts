import path from "path";
export const LIMITS = {
  maxSequenceLength: 1_000_000,
  maxResultsPerAnalysis: 100_000,
};

export const DEFAULT_MIN_PROTEIN_LENGTH = 1; // 单位：氨基酸，不含终止密码子

export const DATA_DIR = path.resolve(process.cwd(), "data");
export const EXPORT_DIR = path.resolve(process.cwd(), "exports");
export const DB_PATH = process.env.ORF_DB_PATH
  ? path.resolve(process.env.ORF_DB_PATH)
  : path.join(DATA_DIR, "orf.sqlite");
