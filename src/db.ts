import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { DB_PATH } from "./config";

export function openDb(dbPath: string = DB_PATH): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sequence_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      version INTEGER NOT NULL,
      raw TEXT NOT NULL,
      cleaned TEXT NOT NULL,
      length INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(name, version)
    );
    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sequence_version_id INTEGER NOT NULL REFERENCES sequence_versions(id),
      min_protein_length INTEGER NOT NULL,
      genetic_code_version TEXT NOT NULL,
      status TEXT NOT NULL,            -- complete | truncated
      result_count INTEGER NOT NULL,
      incomplete_count INTEGER NOT NULL,
      max_results INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      analysis_id INTEGER NOT NULL REFERENCES analyses(id),
      idx INTEGER NOT NULL,            -- 分析内稳定结果编号（从 1 开始）
      strand TEXT NOT NULL,
      frame INTEGER NOT NULL,
      start INTEGER NOT NULL,
      "end" INTEGER NOT NULL,
      nt_length INTEGER NOT NULL,
      protein_length INTEGER NOT NULL,
      start_codon TEXT NOT NULL,
      stop_codon TEXT NOT NULL,
      protein TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_results_analysis ON results(analysis_id);
  `);
  return db;
}
