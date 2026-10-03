// 标准遗传密码表（Standard Genetic Code, NCBI translation table 1）
export const GENETIC_CODE_VERSION = "standard-1";

const TABLE: Record<string, string> = {
  TTT: "F", TTC: "F", TTA: "L", TTG: "L",
  CTT: "L", CTC: "L", CTA: "L", CTG: "L",
  ATT: "I", ATC: "I", ATA: "I", ATG: "M",
  GTT: "V", GTC: "V", GTA: "V", GTG: "V",
  TCT: "S", TCC: "S", TCA: "S", TCG: "S",
  CCT: "P", CCC: "P", CCA: "P", CCG: "P",
  ACT: "T", ACC: "T", ACA: "T", ACG: "T",
  GCT: "A", GCC: "A", GCA: "A", GCG: "A",
  TAT: "Y", TAC: "Y", TAA: "*", TAG: "*",
  CAT: "H", CAC: "H", CAA: "Q", CAG: "Q",
  AAT: "N", AAC: "N", AAA: "K", AAG: "K",
  GAT: "D", GAC: "D", GAA: "E", GAG: "E",
  TGT: "C", TGC: "C", TGA: "*", TGG: "W",
  CGT: "R", CGC: "R", CGA: "R", CGG: "R",
  AGT: "S", AGC: "S", AGA: "R", AGG: "R",
  GGT: "G", GGC: "G", GGA: "G", GGG: "G",
};

export const START_CODON = "ATG";
export const STOP_CODONS = new Set(["TAA", "TAG", "TGA"]);

export function isStop(codon: string): boolean {
  return STOP_CODONS.has(codon);
}

// 含 N（或任何非 ACGT 字符）的密码子翻译为 X；N 既不作起始也不作终止
export function translateCodon(codon: string): string {
  const aa = TABLE[codon];
  return aa === undefined ? "X" : aa;
}

export function translate(nt: string): string {
  let protein = "";
  for (let i = 0; i + 3 <= nt.length; i += 3) {
    protein += translateCodon(nt.slice(i, i + 3));
  }
  return protein;
}
