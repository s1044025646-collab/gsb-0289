# DNA 双链开放阅读框定位与密码子翻译后端

离线、本地运行的 DNA 阅读框分析服务（TypeScript + Node.js + SQLite），只提供 HTTP API 与 CLI，无前端。不依赖 Docker、WSL、付费服务或任何外部在线 API（数据库使用 Node.js 内置的 `node:sqlite`，零原生依赖）。

## 重要声明

本服务是**有限规则识别**工具：只按"ATG 起始、同框第一个 TAA/TAG/TGA 结束"的固定规则定位候选开放阅读框并做标准密码子翻译。**结果不代表真实表达的基因**，不做序列拼接、物种比对、真实基因注释或任何医学判断。

## 环境要求

- Windows 本地，Node.js >= 22.5（使用内置 `node:sqlite`，开发用的是 Node 25）
- 无需安装任何运行时依赖（仅开发依赖 typescript / @types/node）

## 构建、测试、启动、演示

```powershell
npm install        # 安装开发依赖（TypeScript）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部自动化测试
npm start          # 启动 API（默认自动选择空闲端口，PORT=8080 或 --port 指定）
npm run demo       # 六框扫描演示（含负链来源解释）
```

## 输入与清理规则（公开）

1. 删除所有空白字符（空格、制表符、换行、回车等）；
2. 全部转为大写；
3. 只接受 `A`、`C`、`G`、`T`、`N`；**RNA 的 `U` 与其他任何字符一律拒绝**（错误码 `RNA_NOT_SUPPORTED` / `INVALID_SEQUENCE_CHAR`）。

所有坐标均基于**清理后**的序列。

## 扫描规则

- 六个阅读框：正链偏移 0/1/2，反向互补链偏移 0/1/2，分别扫描。
- 每个同框 `ATG` 都是独立候选起点；遇到同框**第一个** `TAA`/`TAG`/`TGA` 结束。嵌套 ATG 各自产生独立结果（如 `ATGATGTAA` 得到 `MM` 和 `M`）。
- 蛋白质包含起始甲硫氨酸、不含终止符；核酸区间包含终止密码子。
- 含 `N` 的密码子翻译为 `X`；`N` 既不作起始也不作终止。
- 末端不足 3 碱基的残片直接丢弃，不拼接到其他阅读框。
- 到末端仍未终止的候选单独统计为 `unterminated_count`，不伪装成完整结果。
- 坐标统一为原序列零基半开区间 `[start, end)`，正负链都满足 `start < end`；负链局部区间 `[s, e)` 映射为 `[L-e, L-s)`。
- `minProteinLength` 单位是氨基酸，不含终止密码子。
- 结果顺序固定（正链框 0/1/2 → 负链框 0/1/2，框内按终止子位置），不按蛋白字符串合并不同位置的结果。

## 上限

- 序列长度上限：1,000,000 bp（`SEQUENCE_TOO_LONG`）
- 单次分析结果数上限：默认 100,000（可用 `maxResults` 调整）；超限分析状态为 `truncated`，**不会**标为完整成功（`completed`）。

## CLI

```powershell
node dist/src/cli.js import <name> <sequence|@file>   # 导入序列（同名产生新版本）
node dist/src/cli.js analyze <sequenceId> [minLen]    # 创建分析
node dist/src/cli.js results <analysisId> [+|-] [minLen]
node dist/src/cli.js explain <analysisId> <+|-> <0|1|2>
node dist/src/cli.js history
node dist/src/cli.js export <analysisId> <json|fasta>
node dist/src/cli.js serve [--port N]
node dist/src/cli.js demo
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/sequences` | 导入序列 `{name, sequence}`，同名产生新版本 |
| GET | `/sequences` / `/sequences/:id` | 列出 / 查看序列 |
| POST | `/analyses` | 创建分析 `{sequenceId, minProteinLength?, maxResults?}` |
| GET | `/analyses` / `/analyses/:id` | 历史 / 详情 |
| GET | `/analyses/:id/results?strand=&minProteinLength=&frameOffset=` | 按链、长度、框过滤 |
| GET | `/analyses/:id/frames/:strand/:offset` | 解释指定阅读框的每个密码子 |
| POST | `/analyses/:id/export/json` 或 `/export/fasta` | 导出到项目 `exports/` 目录 |

错误统一返回 `{"error": {"code", "message", "details?"}}`，错误码包括 `INVALID_SEQUENCE_CHAR`、`RNA_NOT_SUPPORTED`、`EMPTY_SEQUENCE`、`SEQUENCE_TOO_LONG`、`INVALID_PARAMS`、`INVALID_JSON`、`NOT_FOUND`、`INTERNAL_ERROR`。

## 持久化与版本

SQLite 数据库保存在项目内 `data/orf.db`（可用环境变量 `ORF_DATA_DIR` 覆盖，导出目录用 `ORF_EXPORT_DIR` 覆盖）。保存清理前后的序列、分析参数、遗传密码表版本（`SGC-1`，即 NCBI 标准密码表 transl_table=1）与全部结果，重启后可读取。同名再次导入会产生新版本序列，旧版本与其分析报告**不会被修改**。

## 导出

- JSON：完整分析参数与结果。
- 蛋白 FASTA：标题形如 `>orf_<分析ID>_<结果编号> strand=+ coords=0-9 frame=0 len_aa=2`，编号在分析内稳定，坐标为原序列坐标。导出只写入项目内 `exports/` 目录。

## 已知限制

- 仅固定规则识别，不预测真实基因、不处理可变剪接、重叠基因生物学意义或替代起始密码子。
- 只支持标准遗传密码表（暂不提供其他翻译表）。
- 单进程本地服务，无鉴权，仅监听 `127.0.0.1`。
