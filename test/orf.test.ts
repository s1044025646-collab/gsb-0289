import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanSixFrames, proteinFromReportCoords, type OrfResult } from "../src/orf.js";
import { cleanSequence, SequenceError } from "../src/sequence.js";
import { translateNt } from "../src/geneticCode.js";
import { Db } from "../src/db.js";
import { startServer } from "../src/api.js";

function orfs(seq: string, minLen = 1): OrfResult[] {
  return scanSixFrames(seq, minLen).results;
}

// 独立核对：用报告坐标从原序列切片、按链取向后翻译，必须复原同一蛋白。
function checkCoords(seq: string, r: OrfResult): void {
  assert.ok(r.start < r.end, "start < end");
  assert.equal(proteinFromReportCoords(seq, r), r.protein);
}

test("ATGAAATAG 正链 MK [0,9)", () => {
  const r = orfs("ATGAAATAG");
  assert.equal(r.length, 1);
  assert.equal(r[0].strand, "+");
  assert.equal(r[0].frameOffset, 0);
  assert.equal(r[0].protein, "MK");
  assert.equal(r[0].start, 0);
  assert.equal(r[0].end, 9);
  assert.equal(r[0].ntLength, 9);
  assert.equal(r[0].proteinLength, 2);
  assert.equal(r[0].startCodon, "ATG");
  assert.equal(r[0].stopCodon, "TAG");
  checkCoords("ATGAAATAG", r[0]);
});

test("CTATTTCAT 负链 MK，坐标映射回原序列", () => {
  const seq = "CTATTTCAT";
  const r = orfs(seq);
  assert.equal(r.length, 1);
  assert.equal(r[0].strand, "-");
  assert.equal(r[0].protein, "MK");
  // 反向互补链上 ORF 位于局部 [0,9)，映射回原序列仍是 [0,9)
  assert.equal(r[0].start, 0);
  assert.equal(r[0].end, 9);
  checkCoords(seq, r[0]);
});

test("负链坐标映射：局部区间映射为 [L-e, L-s)", () => {
  // 原序列前缀 5 个碱基 + 负链 ORF(ATG AAA TAA 的反向互补 = TTA TTT CAT)
  const seq = "GGGGG" + "TTATTTCAT";
  const r = orfs(seq).filter((x) => x.strand === "-");
  assert.equal(r.length, 1);
  assert.equal(r[0].protein, "MK");
  assert.equal(r[0].start, 5);
  assert.equal(r[0].end, 14);
  checkCoords(seq, r[0]);
});

test("ATGATGTAA 嵌套 ATG 产生 MM 和 M 两个结果", () => {
  const r = orfs("ATGATGTAA").filter((x) => x.strand === "+");
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((x) => x.protein).sort(), ["M", "MM"]);
  for (const x of r) checkCoords("ATGATGTAA", x);
});

test("ATGNNNTAA 翻译为 MX（N 密码子为 X，不作起始/终止）", () => {
  const r = orfs("ATGNNNTAA").filter((x) => x.strand === "+");
  assert.equal(r.length, 1);
  assert.equal(r[0].protein, "MX");
  // NNN 不是终止子，所以只有一个完整 ORF
  assert.equal(translateNt("NNN"), "X");
});

test("非零阅读框", () => {
  const r = orfs("CATGAAATAA").filter((x) => x.strand === "+");
  assert.equal(r.length, 1);
  assert.equal(r[0].frameOffset, 1);
  assert.equal(r[0].protein, "MK");
  assert.equal(r[0].start, 1);
  assert.equal(r[0].end, 10);
});

test("尾部残片不拼接", () => {
  // 框 0 末端剩 2 个碱基，不得与其他框拼接
  const scan = scanSixFrames("ATGAAATAACC", 1);
  assert.equal(scan.results.filter((x) => x.strand === "+").length, 1);
});

test("无终止密码子的候选单独统计", () => {
  const scan = scanSixFrames("ATGAAAGGG", 1);
  assert.equal(scan.results.filter((x) => x.strand === "+").length, 0);
  assert.ok(scan.unterminatedCount >= 1);
});

test("最短蛋白长度过滤（单位氨基酸，不含终止符）", () => {
  assert.equal(orfs("ATGAAATAG", 2).length, 1); // MK 长度 2，保留
  assert.equal(orfs("ATGAAATAG", 3).length, 0); // 要求 3，被过滤
});

test("多个终止时取第一个同框终止子", () => {
  const r = orfs("ATGTAATAA").filter((x) => x.strand === "+");
  assert.equal(r.length, 1);
  assert.equal(r[0].end, 6);
  assert.equal(r[0].protein, "M");
});

test("清理规则：去空白、统一大小写，坐标基于清理后序列", () => {
  assert.equal(cleanSequence(" atg aaa tag\n"), "ATGAAATAG");
  const r = orfs(cleanSequence("atg aaa tag"));
  assert.equal(r[0].start, 0);
  assert.equal(r[0].end, 9);
});

test("坏字符与 RNA U 明确拒绝", () => {
  assert.throws(() => cleanSequence("ATGX"), (e: SequenceError) => e.code === "INVALID_SEQUENCE_CHAR");
  assert.throws(() => cleanSequence("AUGAAA"), (e: SequenceError) => e.code === "RNA_NOT_SUPPORTED");
});

test("持久化：导入、分析、重启后读取；同名导入产生新版本", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "orf-"));
  let db = new Db(dir);
  const s1 = db.importSequence("demo", "ATGAAATAG");
  const { analysis } = db.createAnalysis(s1.id, 1);
  db.close();

  db = new Db(dir); // 模拟重启
  const a = db.getAnalysis(analysis.id);
  assert.equal(a.status, "completed");
  assert.equal(a.genetic_code_version, "SGC-1");
  const rows = db.queryResults(analysis.id, { strand: "+" }) as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].protein, "MK");

  const s2 = db.importSequence("demo", "ATGATGTAA");
  assert.equal(s2.version, 2);
  assert.equal(db.getSequence(s1.id).version, 1); // 旧版本不变
  db.close();
});

test("结果数上限：超限分析标记为 truncated", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "orf-"));
  const db = new Db(dir);
  const seq = db.importSequence("big", "ATG".repeat(50) + "TAA");
  const { analysis } = db.createAnalysis(seq.id, 1, 5);
  assert.equal(analysis.status, "truncated");
  assert.equal(analysis.result_count, 5);
  db.close();
});

test("API 端到端：导入、分析、查询、解释、导出", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "orf-"));
  const exportDir = path.join(dir, "exports");
  const db = new Db(path.join(dir, "data"));
  const { port, close } = await startServer(db, exportDir, 0);
  const base = `http://127.0.0.1:${port}`;

  const bad = await fetch(`${base}/sequences`, {
    method: "POST",
    body: JSON.stringify({ name: "x", sequence: "AUG" }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "RNA_NOT_SUPPORTED");

  const seq = await (await fetch(`${base}/sequences`, {
    method: "POST",
    body: JSON.stringify({ name: "x", sequence: "ATGAAATAG" }),
  })).json();
  const created = await (await fetch(`${base}/analyses`, {
    method: "POST",
    body: JSON.stringify({ sequenceId: seq.id, minProteinLength: 1 }),
  })).json();
  assert.equal(created.status, "completed");

  const minus = await (await fetch(`${base}/analyses/${created.id}/results?strand=-`)).json();
  assert.equal(minus.length, 0);

  const frame = await (await fetch(`${base}/analyses/${created.id}/frames/+/0`)).json();
  assert.equal(frame.codons.length, 3);
  assert.ok(frame.codons[0].isStart);
  assert.ok(frame.codons[2].isStop);

  const exp = await (await fetch(`${base}/analyses/${created.id}/export/fasta`, { method: "POST" })).json();
  assert.ok(exp.exported.startsWith(exportDir));
  const fasta = readFileSync(exp.exported, "utf8");
  assert.match(fasta, />orf_\d+_0 strand=\+ coords=0-9/);
  assert.match(fasta, /MK/);

  const expJson = await (await fetch(`${base}/analyses/${created.id}/export/json`, { method: "POST" })).json();
  assert.ok(existsSync(expJson.exported));

  close();
  db.close();
});
