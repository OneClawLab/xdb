import type { Command } from 'commander';

// ── Help text data ──────────────────────────────────────────

const MAIN_EXAMPLES = `
Examples:
  $ xdb col init my-docs --policy hybrid/knowledge-base
  $ xdb put my-docs '{"content":"How to use tar"}'
  $ xdb find my-docs "compress files" --similar
  $ xdb col list

Prerequisites:
  向量化功能依赖 pai 命令。请确保 pai 已安装并配置了 embedding provider:
    pai model default --embed-provider openai --embed-model text-embedding-3-small

Data:
  数据目录: ~/.local/share/xdb/`;

const MAIN_VERBOSE = `
Policies:
  hybrid/knowledge-base    向量 + 全文检索（最常用）
  relational/structured-logs  结构化日志
  relational/simple-kv     简单键值对
  vector/feature-store     特征存储

Storage:
  ~/.local/share/xdb/collections/<name>/
    collection_meta.json   Policy 快照 + 元数据
    vector.lance/          LanceDB 向量数据
    relational.db          SQLite 关系数据 + FTS

Exit Codes:
  0  成功
  2  参数错误 / 集合不存在 / 能力不匹配
  1  运行时错误（引擎故障、pai 调用失败等）`;

const COL_INIT_EXAMPLES = `
Examples:
  $ xdb col init my-docs --policy hybrid/knowledge-base
  $ xdb col init logs --policy relational
  $ xdb col init my-col --policy hybrid --params '{"fields":{"title":{"findCaps":["match"]}}}'`;

const COL_LIST_EXAMPLES = `
Examples:
  $ xdb col list
  $ xdb col list --json                               # JSON array 输出`;

const COL_RM_EXAMPLES = `
Examples:
  $ xdb col rm my-docs

Warning: 此操作不可逆，将物理删除集合目录及所有索引文件。`;

const PUT_EXAMPLES = `
Examples:
  $ xdb put my-docs '{"content":"How to use tar"}'    # 位置参数
  $ echo '{"content":"Git branching"}' | xdb put my-docs  # stdin 输入
  $ cat data.jsonl | xdb put my-docs --batch           # 批量写入

Stdin:
  支持通过管道传入 JSON 或 JSONL 数据。

Note:
  相同 id 的记录执行 upsert（幂等操作）。
  --batch --json 输出: {"inserted":N,"updated":N,"errors":N}`;

const FIND_EXAMPLES = `
Examples:
  $ xdb find my-docs "compress files" --similar        # 语义搜索
  $ xdb find my-docs "tar compression" --match         # 全文检索
  $ xdb find my-docs --where "json_extract(data, '$.category') = 'network'"
  $ echo "database optimization" | xdb find my-docs --similar  # stdin 查询

Stdin:
  支持通过管道传入查询文本（用于 --similar 和 --match）。

JSON output (--json):
  JSONL 格式，每行一个结果，含 _score 和 _engine 元数据。`;

// ── Setup functions ─────────────────────────────────────────

export function installHelp(program: Command): void {
  program.addHelpText('after', MAIN_EXAMPLES);
  installVerboseHelp(program);
}

export function addColExamples(col: Command): void {
  // Add examples to col subcommands after they are registered
  for (const sub of col.commands) {
    const name = sub.name();
    if (name === 'init') sub.addHelpText('after', COL_INIT_EXAMPLES);
    else if (name === 'list') sub.addHelpText('after', COL_LIST_EXAMPLES);
    else if (name === 'rm') sub.addHelpText('after', COL_RM_EXAMPLES);
  }
}

export function addPutExamples(cmd: Command): void {
  cmd.addHelpText('after', PUT_EXAMPLES);
}

export function addFindExamples(cmd: Command): void {
  cmd.addHelpText('after', FIND_EXAMPLES);
}

function installVerboseHelp(program: Command): void {
  program.option('--verbose', '(与 --help 一起使用) 显示完整帮助信息');
  program.on('option:verbose', () => {
    (program as unknown as Record<string, boolean>).__verboseHelp = true;
  });
  program.addHelpText('afterAll', () => {
    if ((program as unknown as Record<string, boolean>).__verboseHelp) {
      return MAIN_VERBOSE;
    }
    return '';
  });
}
