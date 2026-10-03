# DNA 双链开放阅读框定位与密码子翻译（本地离线后端）

一个纯本地运行的 DNA 阅读框分析服务：接收命名序列，在**正链三个阅读框 + 反向互补链三个阅读框**（共六框）上查找以 `ATG` 开始、以同框终止密码子（`TAA`/`TAG`/`TGA`）结束的完整 ORF，并用**标准遗传密码表**（NCBI 表 1）翻译为蛋白质字符串。只提供 HTTP API 与 CLI，无前端。

> **重要说明**：本工具只做**有限规则识别**（ATG…同框终止的字符串匹配），不做序列拼接、物种比对、真实基因注释或医学判断。**结果不代表真实表达基因**。

## 环境要求

- Windows 本地，Node.js ≥ 22.5（推荐 ≥ 24；使用内置 `node:sqlite`，无需原生编译）
- 不依赖 Docker、WSL、付费服务或任何外部在线 API

## 快速开始

```powershell
npm install        # 安装开发依赖（typescript / @types/node）
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行全部自动化测试
npm start          # 启动 API（默认自动选择空闲端口，PORT=8080 可指定）
npm run demo       # 运行六框扫描 + 负链来源解释演示
```

CLI 直接用法（先 `npm run build`）：

```powershell
node dist/src/cli.js import --name myseq --sequence "ATG AAA TAG CTA TTT CAT"
node dist/src/cli.js analyze --sequence-version-id 1 --min-protein-length 1
node dist/src/cli.js results --analysis-id 1 --strand - --frame 0
node dist/src/cli.js codons --result-id 2
node dist/src/cli.js export --analysis-id 1 --format fasta
node dist/src/cli.js analyses        # 历史
node dist/src/cli.js sequences       # 序列版本
node dist/src/cli.js serve --port 8080
```

## 输入与清理规则（公开）

- 清理：去除**所有空白字符**（空格、制表符、换行、回车等），统一转为**大写**。
- 只接受 `A`、`C`、`G`、`T`、`N`；**其他字母一律拒绝**，RNA 的 `U` 会被明确拒绝并提示。
- 所有结果坐标均为**清理后序列**上的零基半开区间 `[start, end)`。

## 扫描与坐标规则

- 正链偏移 0/1/2 与反向互补链偏移 0/1/2 分别扫描；每个 `ATG` 都是独立候选起点，**嵌套 ATG 产生独立结果**（如 `ATGATGTAA` → `MM` 与 `M`）。
- 遇到**同框第一个**终止密码子即结束；蛋白质包含起始甲硫氨酸、不含终止符；核酸区间**包含**终止密码子。
- 含 `N` 的密码子翻译为 `X`；`N` 既不作起始也不作终止。
- 末端不足 3 碱基的残片直接丢弃，不拼接到其他阅读框。
- 负链局部区间 `[s, e)` 映射回原坐标 `[L-e, L-s)`，任何链都满足 `start < end`。
- 到末端仍未终止的候选计入 `incomplete_count`，**不**伪装成完整结果。
- 输出顺序固定（正链框 0/1/2 → 负链框 0/1/2，各自按位置升序），不按蛋白字符串合并不同位置的结果。
- `minProteinLength` 单位是**氨基酸**，不计终止密码子。

## HTTP API

默认监听 `127.0.0.1` 上的空闲端口（`PORT` 环境变量或 `--port` 可指定）。错误统一返回 `{"error":{"code","message"}}`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/sequences` | 导入序列 `{name, sequence}`；内容变化产生新版本 |
| GET | `/sequences` | 列出所有序列版本 |
| POST | `/analyses` | 创建分析 `{sequenceVersionId, minProteinLength?}` |
| GET | `/analyses` / `/analyses/:id` | 历史 / 详情（含状态与未终止候选数） |
| GET | `/analyses/:id/results?strand=+|-&frame=0|1|2&minProteinLength=n` | 按链/框/长度查询 |
| GET | `/results/:id/codons` | 逐密码子解释（含原序列坐标） |
| POST | `/analyses/:id/export?format=json|fasta` | 导出到项目内 `exports/` 目录 |

错误码：`BAD_REQUEST`、`EMPTY_SEQUENCE`、`INVALID_SEQUENCE_CHAR`、`SEQUENCE_TOO_LONG`、`NOT_FOUND`、`INTERNAL`。

## 导出格式

- **JSON**：分析参数、遗传密码表版本、清理后序列与全部结果。
- **蛋白 FASTA**：标题示例 `>orf_1|analysis=1|strand=+|frame=0|coords=0-9|len_aa=2`，含稳定结果编号、链与原坐标；序列 60 字符折行。
- 导出只写入项目内 `exports/` 目录。

## 持久化与版本

- SQLite 数据库位于项目内 `data/orf.sqlite`（可用环境变量 `ORF_DB_PATH` 覆盖），保存清理前后序列、分析参数、遗传密码表版本（`standard-1`）与全部结果，重启后可读取。
- 同名序列内容变化时创建**新版本**（`version` 递增），旧分析报告保持不变；内容相同则复用当前版本。

## 上限

- 序列长度上限：1,000,000 bp（超限报 `SEQUENCE_TOO_LONG`）。
- 单次分析结果上限：100,000 条；超限时多余结果被丢弃，分析状态标记为 `truncated`（**不会**标为 `complete`）。

## 测试

`npm test` 覆盖：`ATGAAATAG`→正链 `MK`/`[0,9)`；`CTATTTCAT`→负链同翻译及原坐标；`ATGATGTAA` 嵌套双结果；`ATGNNNTAA`→`MX`；非零阅读框、尾部残片、无终止候选、最短长度过滤、多终止取第一个、清理后坐标、坏字符/`U` 拒绝、持久化重读、负链密码子解释、FASTA/JSON 导出，以及用**独立直接切片翻译**核对报告坐标能复原同一蛋白。

## 项目结构

```
src/geneticCode.ts  标准遗传密码表与翻译
src/sequence.ts     清理、校验、反向互补
src/orf.ts          六框 ORF 扫描与坐标映射
src/db.ts           SQLite 建表
src/service.ts      业务逻辑（导入/分析/查询/解释/导出）
src/api.ts          HTTP API（node:http）
src/cli.ts          命令行入口
src/demo.ts         演示脚本
test/orf.test.ts    自动化测试
```
