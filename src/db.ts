import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { GENETIC_CODE_VERSION } from "./geneticCode.js";
import { scanSixFrames, DEFAULT_MAX_RESULTS, type OrfResult } from "./orf.js";
import { cleanSequence, SequenceError } from "./sequence.js";

export interface SequenceRow {
  id: number;
  name: string;
  version: number;
  raw_sequence: string;
  cleaned_sequence: string;
  length: number;
  created_at: string;
}

export interface AnalysisRow {
  id: number;
  sequence_id: number;
  min_protein_length: number;
  max_results: number;
  genetic_code_version: string;
  status: string; // completed | truncated
  result_count: number;
  unterminated_count: number;
  created_at: string;
}

export class NotFoundError extends Error {
  code = "NOT_FOUND";
}

export class Db {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "orf.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sequences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        raw_sequence TEXT NOT NULL,
        cleaned_sequence TEXT NOT NULL,
        length INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sequence_id INTEGER NOT NULL REFERENCES sequences(id),
        min_protein_length INTEGER NOT NULL,
        max_results INTEGER NOT NULL,
        genetic_code_version TEXT NOT NULL,
        status TEXT NOT NULL,
        result_count INTEGER NOT NULL,
        unterminated_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        analysis_id INTEGER NOT NULL REFERENCES analyses(id),
        result_index INTEGER NOT NULL,
        strand TEXT NOT NULL,
        frame_offset INTEGER NOT NULL,
        start INTEGER NOT NULL,
        end INTEGER NOT NULL,
        nt_length INTEGER NOT NULL,
        protein_length INTEGER NOT NULL,
        start_codon TEXT NOT NULL,
        stop_codon TEXT NOT NULL,
        protein TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_results_analysis ON results(analysis_id);
    `);
  }

  close(): void {
    this.db.close();
  }

  // 同名导入产生新版本，旧版本与其分析报告保持不变。
  importSequence(name: string, rawSequence: string): SequenceRow {
    if (!name || typeof name !== "string") {
      throw new SequenceError("INVALID_PARAMS", "name 必须是非空字符串");
    }
    const cleaned = cleanSequence(rawSequence);
    const row = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM sequences WHERE name = ?")
      .get(name) as { v: number };
    const version = row.v + 1;
    const info = this.db
      .prepare(
        "INSERT INTO sequences (name, version, raw_sequence, cleaned_sequence, length) VALUES (?, ?, ?, ?, ?)",
      )
      .run(name, version, rawSequence, cleaned, cleaned.length);
    return this.getSequence(Number(info.lastInsertRowid));
  }

  getSequence(id: number): SequenceRow {
    const row = this.db.prepare("SELECT * FROM sequences WHERE id = ?").get(id) as
      | SequenceRow
      | undefined;
    if (!row) throw new NotFoundError(`序列 ${id} 不存在`);
    return row;
  }

  listSequences(): SequenceRow[] {
    return this.db
      .prepare("SELECT * FROM sequences ORDER BY name, version")
      .all() as unknown as SequenceRow[];
  }

  createAnalysis(
    sequenceId: number,
    minProteinLength = 1,
    maxResults: number = DEFAULT_MAX_RESULTS,
  ): { analysis: AnalysisRow; results: OrfResult[] } {
    if (!Number.isInteger(minProteinLength) || minProteinLength < 1) {
      throw new SequenceError("INVALID_PARAMS", "minProteinLength 必须是 >= 1 的整数");
    }
    if (!Number.isInteger(maxResults) || maxResults < 1) {
      throw new SequenceError("INVALID_PARAMS", "maxResults 必须是 >= 1 的整数");
    }
    const seq = this.getSequence(sequenceId);
    const scan = scanSixFrames(seq.cleaned_sequence, minProteinLength, maxResults);
    const status = scan.truncated ? "truncated" : "completed";
    const info = this.db
      .prepare(
        `INSERT INTO analyses
         (sequence_id, min_protein_length, max_results, genetic_code_version, status, result_count, unterminated_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sequenceId,
        minProteinLength,
        maxResults,
        GENETIC_CODE_VERSION,
        status,
        scan.results.length,
        scan.unterminatedCount,
      );
    const analysisId = Number(info.lastInsertRowid);
    const insert = this.db.prepare(
      `INSERT INTO results
       (analysis_id, result_index, strand, frame_offset, start, end, nt_length, protein_length, start_codon, stop_codon, protein)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    scan.results.forEach((r, i) => {
      insert.run(
        analysisId, i, r.strand, r.frameOffset, r.start, r.end,
        r.ntLength, r.proteinLength, r.startCodon, r.stopCodon, r.protein,
      );
    });
    return { analysis: this.getAnalysis(analysisId), results: scan.results };
  }

  getAnalysis(id: number): AnalysisRow {
    const row = this.db.prepare("SELECT * FROM analyses WHERE id = ?").get(id) as
      | AnalysisRow
      | undefined;
    if (!row) throw new NotFoundError(`分析 ${id} 不存在`);
    return row;
  }

  listAnalyses(): AnalysisRow[] {
    return this.db
      .prepare("SELECT * FROM analyses ORDER BY id DESC")
      .all() as unknown as AnalysisRow[];
  }

  queryResults(
    analysisId: number,
    filter: { strand?: string; minProteinLength?: number; frameOffset?: number } = {},
  ): unknown[] {
    this.getAnalysis(analysisId);
    let sql = "SELECT * FROM results WHERE analysis_id = ?";
    const params: (string | number)[] = [analysisId];
    if (filter.strand !== undefined) {
      if (filter.strand !== "+" && filter.strand !== "-") {
        throw new SequenceError("INVALID_PARAMS", "strand 只能是 + 或 -");
      }
      sql += " AND strand = ?";
      params.push(filter.strand);
    }
    if (filter.minProteinLength !== undefined) {
      sql += " AND protein_length >= ?";
      params.push(filter.minProteinLength);
    }
    if (filter.frameOffset !== undefined) {
      sql += " AND frame_offset = ?";
      params.push(filter.frameOffset);
    }
    sql += " ORDER BY result_index";
    return this.db.prepare(sql).all(...params);
  }
}
