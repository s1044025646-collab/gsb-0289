import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { cleanSequence, SeqError, reverseComplement } from "./sequence";
import { scanOrfs, OrfRecord, Strand } from "./orf";
import { GENETIC_CODE_VERSION, translateCodon } from "./geneticCode";
import { LIMITS, DEFAULT_MIN_PROTEIN_LENGTH, EXPORT_DIR } from "./config";

export { SeqError };

export class ApiError extends Error {
  constructor(public code: string, message: string, public httpStatus = 400) {
    super(message);
  }
}

export interface SequenceVersionRow {
  id: number; name: string; version: number; raw: string; cleaned: string; length: number; created_at: string;
}

export interface AnalysisRow {
  id: number; sequence_version_id: number; min_protein_length: number;
  genetic_code_version: string; status: string; result_count: number;
  incomplete_count: number; max_results: number; created_at: string;
}

export interface ResultRow extends OrfRecord {
  id: number; analysis_id: number; idx: number;
}

function now(): string {
  return new Date().toISOString();
}

export function importSequence(db: DatabaseSync, name: string, raw: string): SequenceVersionRow {
  if (!name || !name.trim()) throw new ApiError("BAD_REQUEST", "name 不能为空");
  const cleaned = cleanSequence(raw);
  if (cleaned.length > LIMITS.maxSequenceLength) {
    throw new ApiError("SEQUENCE_TOO_LONG", `序列长度 ${cleaned.length} 超过上限 ${LIMITS.maxSequenceLength}`);
  }
  const existing = db.prepare(
    "SELECT * FROM sequence_versions WHERE name = ? ORDER BY version DESC LIMIT 1"
  ).get(name) as unknown as SequenceVersionRow | undefined;
  if (existing && existing.cleaned === cleaned) {
    return existing; // 内容未变化，复用当前版本
  }
  const version = existing ? existing.version + 1 : 1;
  const info = db.prepare(
    "INSERT INTO sequence_versions (name, version, raw, cleaned, length, created_at) VALUES (?,?,?,?,?,?)"
  ).run(name, version, raw, cleaned, cleaned.length, now());
  return db.prepare("SELECT * FROM sequence_versions WHERE id = ?").get(Number(info.lastInsertRowid)) as unknown as SequenceVersionRow;
}

export function listSequences(db: DatabaseSync): SequenceVersionRow[] {
  return db.prepare("SELECT * FROM sequence_versions ORDER BY name, version").all() as unknown as SequenceVersionRow[];
}

export function getSequenceVersion(db: DatabaseSync, id: number): SequenceVersionRow {
  const row = db.prepare("SELECT * FROM sequence_versions WHERE id = ?").get(id) as unknown as SequenceVersionRow | undefined;
  if (!row) throw new ApiError("NOT_FOUND", `序列版本 ${id} 不存在`, 404);
  return row;
}

export function createAnalysis(db: DatabaseSync, sequenceVersionId: number, minProteinLength?: number): AnalysisRow {
  const sv = getSequenceVersion(db, sequenceVersionId);
  const minLen = minProteinLength ?? DEFAULT_MIN_PROTEIN_LENGTH;
  if (!Number.isInteger(minLen) || minLen < 1) {
    throw new ApiError("BAD_REQUEST", "minProteinLength 必须是 >= 1 的整数（单位：氨基酸，不含终止密码子）");
  }
  const { orfs, incompleteCount } = scanOrfs(sv.cleaned, minLen);
  const truncated = orfs.length > LIMITS.maxResultsPerAnalysis;
  const kept = truncated ? orfs.slice(0, LIMITS.maxResultsPerAnalysis) : orfs;
  const info = db.prepare(
    `INSERT INTO analyses (sequence_version_id, min_protein_length, genetic_code_version, status, result_count, incomplete_count, max_results, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(sv.id, minLen, GENETIC_CODE_VERSION, truncated ? "truncated" : "complete", kept.length, incompleteCount, LIMITS.maxResultsPerAnalysis, now());
  const analysisId = Number(info.lastInsertRowid);
  const insert = db.prepare(
    `INSERT INTO results (analysis_id, idx, strand, frame, start, "end", nt_length, protein_length, start_codon, stop_codon, protein)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  kept.forEach((orf, i) => {
    insert.run(analysisId, i + 1, orf.strand, orf.frame, orf.start, orf.end, orf.ntLength, orf.proteinLength, orf.startCodon, orf.stopCodon, orf.protein);
  });
  return getAnalysis(db, analysisId);
}

export function getAnalysis(db: DatabaseSync, id: number): AnalysisRow {
  const row = db.prepare("SELECT * FROM analyses WHERE id = ?").get(id) as unknown as AnalysisRow | undefined;
  if (!row) throw new ApiError("NOT_FOUND", `分析 ${id} 不存在`, 404);
  return row;
}

export function listAnalyses(db: DatabaseSync): AnalysisRow[] {
  return db.prepare("SELECT * FROM analyses ORDER BY id").all() as unknown as AnalysisRow[];
}

export interface ResultFilter {
  strand?: Strand;
  frame?: number;
  minProteinLength?: number;
}

export function queryResults(db: DatabaseSync, analysisId: number, filter: ResultFilter = {}): ResultRow[] {
  getAnalysis(db, analysisId);
  const clauses = ["analysis_id = ?"];
  const params: (string | number)[] = [analysisId];
  if (filter.strand !== undefined) {
    if (filter.strand !== "+" && filter.strand !== "-") throw new ApiError("BAD_REQUEST", "strand 只能是 + 或 -");
    clauses.push("strand = ?"); params.push(filter.strand);
  }
  if (filter.frame !== undefined) {
    if (![0, 1, 2].includes(filter.frame)) throw new ApiError("BAD_REQUEST", "frame 只能是 0/1/2");
    clauses.push("frame = ?"); params.push(filter.frame);
  }
  if (filter.minProteinLength !== undefined) {
    clauses.push("protein_length >= ?"); params.push(filter.minProteinLength);
  }
  const rows = db.prepare(`SELECT * FROM results WHERE ${clauses.join(" AND ")} ORDER BY idx`).all(...params) as unknown as any[];
  return rows.map(rowToOrf);
}

export function getResult(db: DatabaseSync, resultId: number): ResultRow {
  const row = db.prepare("SELECT * FROM results WHERE id = ?").get(resultId) as any;
  if (!row) throw new ApiError("NOT_FOUND", `结果 ${resultId} 不存在`, 404);
  return rowToOrf(row);
}

function rowToOrf(row: any): ResultRow {
  return {
    id: row.id, analysis_id: row.analysis_id, idx: row.idx,
    strand: row.strand, frame: row.frame, start: row.start, end: row.end,
    ntLength: row.nt_length, proteinLength: row.protein_length,
    startCodon: row.start_codon, stopCodon: row.stop_codon, protein: row.protein,
  };
}

export interface CodonExplanation {
  codonIndex: number; // 0 起；最后一个为终止密码子
  codon: string;
  aminoAcid: string;  // 终止密码子为 *
  originalStart: number; // 原序列零基坐标
  originalEnd: number;
}

// 解释指定结果的密码子：逐个列出密码子、对应氨基酸及原序列坐标
export function explainResult(db: DatabaseSync, resultId: number): { result: ResultRow; codons: CodonExplanation[] } {
  const result = getResult(db, resultId);
  const analysis = getAnalysis(db, result.analysis_id);
  const sv = getSequenceVersion(db, analysis.sequence_version_id);
  const segment = sv.cleaned.slice(result.start, result.end);
  const oriented = result.strand === "+" ? segment : reverseComplement(segment);
  const codons: CodonExplanation[] = [];
  for (let i = 0; i + 3 <= oriented.length; i += 3) {
    const codon = oriented.slice(i, i + 3);
    let originalStart: number, originalEnd: number;
    if (result.strand === "+") {
      originalStart = result.start + i;
      originalEnd = originalStart + 3;
    } else {
      originalEnd = result.end - i;
      originalStart = originalEnd - 3;
    }
    codons.push({ codonIndex: i / 3, codon, aminoAcid: translateCodon(codon), originalStart, originalEnd });
  }
  return { result, codons };
}

export function exportAnalysisJson(db: DatabaseSync, analysisId: number, outDir: string = EXPORT_DIR): string {
  const analysis = getAnalysis(db, analysisId);
  const sv = getSequenceVersion(db, analysis.sequence_version_id);
  const results = queryResults(db, analysisId);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `analysis-${analysisId}.json`);
  fs.writeFileSync(file, JSON.stringify({
    analysis,
    sequence: { id: sv.id, name: sv.name, version: sv.version, length: sv.length, cleaned: sv.cleaned },
    geneticCodeVersion: GENETIC_CODE_VERSION,
    results,
  }, null, 2));
  return file;
}

export function exportAnalysisFasta(db: DatabaseSync, analysisId: number, outDir: string = EXPORT_DIR): string {
  getAnalysis(db, analysisId);
  const results = queryResults(db, analysisId);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `analysis-${analysisId}.fasta`);
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`>orf_${r.idx}|analysis=${r.analysis_id}|strand=${r.strand}|frame=${r.frame}|coords=${r.start}-${r.end}|len_aa=${r.proteinLength}`);
    for (let i = 0; i < r.protein.length; i += 60) lines.push(r.protein.slice(i, i + 60));
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}
