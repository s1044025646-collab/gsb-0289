import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { scanOrfs } from "../src/orf";
import { cleanSequence, reverseComplement, SeqError } from "../src/sequence";
import { translate } from "../src/geneticCode";
import { openDb } from "../src/db";
import * as svc from "../src/service";

function plusOnly(seq: string, minLen = 1) {
  return scanOrfs(seq, minLen).orfs.filter((o) => o.strand === "+");
}

test("ATGAAATAG 正链得到 MK 与 [0,9)", () => {
  const orfs = plusOnly("ATGAAATAG");
  assert.equal(orfs.length, 1);
  assert.equal(orfs[0].protein, "MK");
  assert.deepEqual([orfs[0].start, orfs[0].end], [0, 9]);
  assert.equal(orfs[0].strand, "+");
  assert.equal(orfs[0].frame, 0);
  assert.equal(orfs[0].ntLength, 9);
  assert.equal(orfs[0].proteinLength, 2);
  assert.equal(orfs[0].stopCodon, "TAG");
});

test("CTATTTCAT 负链得到 MK 及原坐标 [0,9)", () => {
  const { orfs } = scanOrfs("CTATTTCAT", 1);
  assert.equal(orfs.length, 1);
  const o = orfs[0];
  assert.equal(o.strand, "-");
  assert.equal(o.protein, "MK");
  assert.deepEqual([o.start, o.end], [0, 9]);
  assert.ok(o.start < o.end);
});

test("ATGATGTAA 产生嵌套结果 MM 与 M", () => {
  const orfs = plusOnly("ATGATGTAA");
  assert.equal(orfs.length, 2);
  assert.equal(orfs[0].protein, "MM");
  assert.deepEqual([orfs[0].start, orfs[0].end], [0, 9]);
  assert.equal(orfs[1].protein, "M");
  assert.deepEqual([orfs[1].start, orfs[1].end], [3, 9]);
});

test("ATGNNNTAA 含 N 密码子翻译为 X（MX）", () => {
  const orfs = plusOnly("ATGNNNTAA");
  assert.equal(orfs.length, 1);
  assert.equal(orfs[0].protein, "MX");
});

test("非零阅读框：AATGAAATAA 在 frame 1 得到 MK [1,10)", () => {
  const orfs = plusOnly("AATGAAATAA");
  assert.equal(orfs.length, 1);
  assert.equal(orfs[0].frame, 1);
  assert.equal(orfs[0].protein, "MK");
  assert.deepEqual([orfs[0].start, orfs[0].end], [1, 10]);
});

test("尾部残片不拼接：ATGAAATAAG 仍为 [0,9)", () => {
  const orfs = plusOnly("ATGAAATAAG");
  assert.equal(orfs.length, 1);
  assert.deepEqual([orfs[0].start, orfs[0].end], [0, 9]);
});

test("无终止候选单独统计，不进入完整结果", () => {
  const { orfs, incompleteCount } = scanOrfs("ATGAAA", 1);
  assert.equal(orfs.filter((o) => o.strand === "+").length, 0);
  assert.ok(incompleteCount >= 1);
});

test("最短蛋白长度过滤（单位：氨基酸，不含终止）", () => {
  assert.equal(plusOnly("ATGATGTAA", 2).length, 1); // 只剩 MM
  assert.equal(plusOnly("ATGATGTAA", 3).length, 0);
});

test("多个同框终止时取第一个：ATGTAATAA 得到 M [0,6)", () => {
  const orfs = plusOnly("ATGTAATAA");
  assert.equal(orfs.length, 1);
  assert.equal(orfs[0].protein, "M");
  assert.deepEqual([orfs[0].start, orfs[0].end], [0, 6]);
});

test("清理后坐标：空白与大小写不影响区间", () => {
  const cleaned = cleanSequence("  atg aaa\ntag ");
  assert.equal(cleaned, "ATGAAATAG");
  const orfs = plusOnly(cleaned);
  assert.deepEqual([orfs[0].start, orfs[0].end], [0, 9]);
});

test("坏字符与 U 明确拒绝", () => {
  assert.throws(() => cleanSequence("ATGX"), (e: SeqError) => e.code === "INVALID_SEQUENCE_CHAR");
  assert.throws(() => cleanSequence("AUGAA"), (e: SeqError) => e.code === "INVALID_SEQUENCE_CHAR");
  assert.throws(() => cleanSequence("   "), (e: SeqError) => e.code === "EMPTY_SEQUENCE");
});

test("直接切片翻译核对：报告坐标可复原同一蛋白（正负链）", () => {
  const seq = "GGATGAAATAGCCCTATTTCATGGGATGNNNTGA";
  const { orfs } = scanOrfs(seq, 1);
  assert.ok(orfs.length >= 3);
  for (const o of orfs) {
    const segment = seq.slice(o.start, o.end);
    const oriented = o.strand === "+" ? segment : reverseComplement(segment);
    assert.equal(oriented.slice(0, 3), "ATG");
    assert.ok(["TAA", "TAG", "TGA"].includes(oriented.slice(-3)));
    assert.equal(translate(oriented.slice(0, -3)), o.protein);
    assert.equal(o.ntLength, o.end - o.start);
  }
});

test("持久化：写入后重开数据库可读取，修改序列产生新版本", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orf-test-"));
  const dbPath = path.join(dir, "t.sqlite");
  let db = openDb(dbPath);
  const sv1 = svc.importSequence(db, "seq1", "ATGAAATAG");
  const a1 = svc.createAnalysis(db, sv1.id);
  assert.equal(a1.status, "complete");
  db.close();

  db = openDb(dbPath); // 模拟重启
  const analyses = svc.listAnalyses(db);
  assert.equal(analyses.length, 1);
  assert.equal(analyses[0].genetic_code_version, "standard-1");
  const results = svc.queryResults(db, a1.id, { strand: "+" });
  assert.equal(results[0].protein, "MK");

  // 修改序列 → 新版本，旧报告不变
  const sv2 = svc.importSequence(db, "seq1", "ATGAAATAA");
  assert.equal(sv2.version, 2);
  const oldResults = svc.queryResults(db, a1.id);
  assert.equal(oldResults[0].protein, "MK");
  // 内容相同则复用版本
  const sv3 = svc.importSequence(db, "seq1", "ATGAAATAA");
  assert.equal(sv3.version, 2);
  db.close();
});

test("密码子解释：负链结果坐标映射回原序列", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orf-test-"));
  const db = openDb(path.join(dir, "t.sqlite"));
  const sv = svc.importSequence(db, "neg", "CTATTTCAT");
  const a = svc.createAnalysis(db, sv.id);
  const results = svc.queryResults(db, a.id, { strand: "-" });
  assert.equal(results.length, 1);
  const { codons } = svc.explainResult(db, results[0].id);
  assert.deepEqual(codons.map((c) => c.codon), ["ATG", "AAA", "TAG"]);
  assert.deepEqual(codons.map((c) => c.aminoAcid), ["M", "K", "*"]);
  assert.deepEqual([codons[0].originalStart, codons[0].originalEnd], [6, 9]);
  assert.deepEqual([codons[2].originalStart, codons[2].originalEnd], [0, 3]);
  db.close();
});

test("FASTA 导出标题含稳定编号、链与原坐标；JSON 可导出", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orf-test-"));
  const db = openDb(path.join(dir, "t.sqlite"));
  const sv = svc.importSequence(db, "exp", "ATGAAATAG");
  const a = svc.createAnalysis(db, sv.id);
  const fasta = svc.exportAnalysisFasta(db, a.id, dir);
  const content = fs.readFileSync(fasta, "utf8");
  assert.match(content, />orf_1\|analysis=\d+\|strand=\+\|frame=0\|coords=0-9\|len_aa=2/);
  assert.match(content, /\nMK\n/);
  const jsonFile = svc.exportAnalysisJson(db, a.id, dir);
  const parsed = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
  assert.equal(parsed.results[0].protein, "MK");
  db.close();
});
