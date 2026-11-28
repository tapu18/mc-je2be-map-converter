// 作者が読む変換レポート（design.md 5.11、#351）。
// 変換の JSON（ConvertReport）の reason・issues を安定した警告コードと日本語の文に対応づけ、Markdown にする。
// 作者は Java 側だけを直せる前提で書く（#117）。英語の内部の理由は Markdown にそのまま出さない。
import type { ConvertReport } from "./convert.ts";

/** action：変換できず省いた・動かない恐れ。caution：変換したが変わり得る。info：処理の記録 */
export type WarningSeverity = "action" | "caution" | "info";
export type WarningArea = "command_block" | "chain" | "datapack" | "entity" | "score" | "storage";

export interface ReportWarning {
  /** 安定した警告コード。分類できない理由は UNCLASSIFIED（試験で落とす） */
  code: string;
  severity: WarningSeverity;
  area: WarningArea;
  /** どこが（Java の次元・座標、パック名と path:行） */
  where: string;
  /** 何が（元のコマンド、エンティティの種類と属性） */
  what?: string;
  /** なぜ（日本語） */
  message: string;
  /** Java 側で直す内容。決まっていなければ「対処は未定」 */
  remedy: string;
  /** 元の reason・issue。日本語のときだけ Markdown に詳細として出す */
  detail?: string;
}

interface Rule {
  code: string;
  pattern: RegExp;
  message: string | ((match: RegExpExecArray) => string);
  remedy?: string;
}

export const UNDECIDED = "対処は未定（変換器の対応を待つ）";
const JAPANESE = /[぀-ヿ㐀-鿿]/;
export const isJapanese = (text: string): boolean => JAPANESE.test(text);

const versionUpgrade: Rule = {
  code: "CMD_VERSION_UPGRADE", pattern: /^\d[\d.]* → \d[\d.]*: /,
  message: "旧版の書き方を新しい版の形に正確に直せない", remedy: "Java 側で対象の版の書き方に直す",
};

/** 分野ごとの規則。上から順に当てはめ、日本語の理由は分野の汎用コードで受ける。 */
const RULES: Record<WarningArea, Rule[]> = {
  command_block: [
    { code: "CMD_GRAMMAR_UNAVAILABLE", pattern: /^DataVersion .* の文法がない/, message: "ワールドの版のコマンド文法がなく、コマンドを書き換えていない" },
    versionUpgrade,
    { code: "CMD_NOT_NATIVE", pattern: JAPANESE, message: "BE のコマンド 1 個に書き換えられない" },
  ],
  chain: [
    { code: "CHAIN_SHAPE", pattern: /^チェーンの構成が未対応/, message: "チェーンのつながり方（分岐・合流・ループなど）に未対応のものがある", remedy: "Java 側でチェーンを一本道につなぎ直せるか確かめる" },
    { code: "CHAIN_PENDING_DECISION", pattern: /^#93 の判断待ち/, message: "BE に任せた命令の成否を後段が参照しており、扱いが決まっていない" },
    { code: "CHAIN_RUNTIME_PACK", pattern: /^ランタイムパック/, message: "ランタイムパックを作れず、チェーンをランタイムで実行できない" },
    { code: "CHAIN_DIMENSION", pattern: /^ランタイムで未対応のディメンション/, message: "カスタムディメンションのチェーンはランタイムで実行できない" },
    { code: "CHAIN_CONDITIONAL", pattern: /^条件付きブロックが/, message: "条件付きブロックが、ランタイムで再現できない成否を参照する" },
    { code: "CHAIN_FUNCTION", pattern: /^(呼び出し先の|再帰する関数|関数呼び出しが)/, message: "呼び出す関数を静的に判定できない" },
    { code: "CHAIN_ENTITY_NBT", pattern: /^unsupported entity NBT: /, message: "エンティティの NBT の読み書きのうち、ランタイムで未対応の形を使う" },
    { code: "CHAIN_GRAMMAR_UNAVAILABLE", pattern: /^DataVersion .* の文法がない/, message: "ワールドの版のコマンド文法がなく、チェーンを振り分けていない" },
    versionUpgrade,
    { code: "CHAIN_UNSUPPORTED", pattern: JAPANESE, message: "チェーンの命令にランタイム・BE のどちらでも実行できないものがある" },
  ],
  datapack: [
    { code: "DP_BUILTIN_PACK", pattern: /^builtin pack not bundled$/, message: "Java 組み込みのデータパック（実験的機能など）は同梱しない" },
    { code: "DP_OVERLAY", pattern: /^(overlay selection unavailable|invalid overlay)$/, message: "pack.mcmeta のオーバーレイを選べず、オーバーレイの中身を使っていない", remedy: "Java 側で overlays の directory と formats を確かめる" },
    { code: "DP_PACK_FORMAT", pattern: /^invalid pack format$/, message: "pack.mcmeta の pack_format を読み取れず、関数を読んでいない", remedy: "Java 側で pack.mcmeta の pack_format（または min_format・max_format）を確かめる" },
    { code: "DP_GRAMMAR_UNAVAILABLE", pattern: /^(unavailable|grammar unavailable)$/, message: "パックの版に合うコマンド文法がなく、関数を読んでいない" },
    { code: "DP_GRAMMAR_AMBIGUOUS", pattern: /^ambiguous$/, message: "pack_format だけでは文法の版が一つに決まらず、関数を読んでいない" },
    { code: "DP_TAG_JSON", pattern: /^invalid tag JSON$/, message: "関数タグの JSON を読み取れない", remedy: "Java 側でタグの JSON の書式を直す" },
    { code: "DP_PARSE_FAILED", pattern: /^command parse failed$/, message: "パックの版のコマンドとして読めない行があり、この関数を同梱していない", remedy: "Java 側でこの行が対象の版で動くか確かめる" },
    { code: "DP_MACRO_PLACEHOLDER", pattern: /^invalid macro placeholder$/, message: "マクロ行の $(…) の書き方が正しくない", remedy: "Java 側で $(名前) の書き方を直す" },
    { code: "DP_MACRO_SHAPE", pattern: /^(macro hole can change command shape|macro values produce different command shapes|cannot determine fixed command shape)/, message: "マクロの値によってコマンドの形が変わり得るため、事前に変換できない", remedy: "Java 側でマクロの値がコマンド名やサブコマンドを変えないようにする" },
    { code: "DP_MACRO_BOUNDARY", pattern: /^(macro hole crosses an argument boundary|macro values produce different argument boundaries|macro value changes argument boundaries)/, message: "マクロの値が引数の区切りをまたぐため、事前に変換できない", remedy: "Java 側でマクロの値を引数 1 個の中に収める" },
    { code: "DP_MACRO_ARGUMENT_TYPE", pattern: /^macro argument type (\S+) is unsupported or requires an ID mapping/, message: (m) => `マクロの値が入る引数の型（${m[1]}）は、値を ID の対応表で変換する必要があるか未対応` },
    versionUpgrade,
    { code: "DP_UNSUPPORTED", pattern: JAPANESE, message: "関数の行を変換できず、この関数を同梱していない" },
  ],
  entity: [
    { code: "ENTITY_PASSENGER", pattern: /^乗客の再配置は未対応$/, message: "乗り物に乗ったエンティティは再配置しない" },
    { code: "ENTITY_DIMENSION", pattern: /^カスタムディメンション/, message: "カスタムディメンションのエンティティは再配置しない" },
    { code: "ENTITY_JAVA_ONLY", pattern: /^Java 専用/, message: "Java 専用のエンティティで、BE に同じものがない" },
    { code: "ENTITY_SPECIAL_TYPE", pattern: /^種類専用の再配置が必要$/, message: "この種類は専用の再配置が必要で、まだ再配置しない" },
    { code: "ENTITY_NO_POSITION", pattern: /^位置を読み取れない$/, message: "保存データから位置を読み取れない" },
    { code: "ENTITY_DUPLICATE_UUID", pattern: /^同じ UUID/, message: "同じ UUID のエンティティが複数保存されている", remedy: "Java 側で重複したエンティティを 1 体にする" },
    { code: "ENTITY_NAME", pattern: /^(旧版の名前|名前の|翻訳・スコア等の動的テキスト|テキストの|score の対象)/, message: "名前（CustomName）の一部を再現できない" },
    { code: "ENTITY_TAG", pattern: /^空または長すぎるタグ/, message: "空または 256 文字以上のタグを省いた" },
    { code: "ENTITY_INVISIBLE", pattern: /^この種類の透明化は未対応$/, message: "この種類の透明化（Invisible）は再現しない" },
    { code: "ENTITY_VILLAGER", pattern: /^(職業に対応する|取引レベル|.+ の服装を)/, message: "村人の職業・レベル・服装の一部を再現しない" },
    { code: "ENTITY_EQUIPMENT", pattern: /のスロットまたはデータ値は未対応$|の追加データを省略$/, message: "装備の一部（スロット、データ値、追加データ）を再現しない" },
    { code: "ENTITY_FIELD_NOT_RESTORED", pattern: /^保存値の復元は未対応$/, message: "この保存値は再現しない" },
    { code: "ENTITY_FIELD", pattern: JAPANESE, message: "エンティティの属性の一部を再現しない" },
  ],
  score: [
    { code: "SCORE_ENTITY_MISSING", pattern: /^UUID に対応する再配置対象がない$/, message: "スコアを持つエンティティを再配置しないため、このスコアは移さない" },
  ],
  storage: [
    { code: "STORAGE_UNREADABLE", pattern: /./, message: "storage を読み取れない、または初期化パックに入れられない" },
  ],
};

/** 理由に警告コードと日本語の文を付ける。どの規則にも当たらなければ undefined。 */
export function classifyReason(area: WarningArea, reason: string): { code: string; message: string; remedy: string } | undefined {
  for (const rule of RULES[area]) {
    const match = rule.pattern.exec(reason);
    if (!match) continue;
    return { code: rule.code, message: typeof rule.message === "string" ? rule.message : rule.message(match), remedy: rule.remedy ?? UNDECIDED };
  }
  return undefined;
}

const FUNCTION_DIRECTORY = /^(tags\/)?functions?$/;
const fmt = (n: number): string => Number.isInteger(n) ? String(n) : n.toFixed(2);
const site = (dimension: string, pos: readonly number[]): string => `${dimension} (${pos.map(fmt).join(", ")})`;

/** ConvertReport の全項目を警告の一覧にする。 */
export function collectWarnings(report: ConvertReport): ReportWarning[] {
  const warnings: ReportWarning[] = [];
  const add = (area: WarningArea, severity: WarningSeverity, where: string, reason: string, what?: string, fixed?: { code: string; message: string; remedy?: string }) => {
    const classified = fixed ? { remedy: UNDECIDED, ...fixed } : classifyReason(area, reason);
    // 情報は処理の記録で、作者が直すものではない。
    if (classified && severity === "info") classified.remedy = "不要";
    warnings.push({
      code: classified?.code ?? "UNCLASSIFIED", severity, area, where,
      ...(what === undefined ? {} : { what }),
      message: classified?.message ?? "分類していない理由（変換器の不具合として報告してください）",
      remedy: classified?.remedy ?? UNDECIDED,
      ...(reason ? { detail: reason } : {}),
    });
  };
  const commands = report.commands;
  if (commands) {
    const runtimeBlocks = new Set<string>();
    for (const chain of commands.chains) if (chain.status === "runtime") for (const pos of chain.blocks) runtimeBlocks.add(site(chain.head.dimension, pos));
    for (const block of commands.commandBlocks) {
      const where = site(block.dimension, block.pos);
      // チェーンごとランタイムで動くブロックでは、BE コマンドへの書き換えの結果を使わない。
      const runtime = runtimeBlocks.has(where);
      if (block.status === "invalid") {
        add("command_block", runtime ? "info" : "action", where, block.error ?? "", block.java,
          { code: "CMD_INVALID", message: "ワールドの版の Java コマンドとして読めない", remedy: "Java 側でこのコマンドが動くか確かめる" });
      }
      for (const issue of block.issues) {
        const severity = runtime ? "info" : issue.severity === "unsupported" ? "action" : "caution";
        if (issue.severity === "warning") add("command_block", severity, where, issue.message, block.java, { code: "CMD_REWRITE_CHANGED", message: "BE のコマンドに書き換えたが、意味や見た目が変わり得る" });
        else add("command_block", severity, where, issue.message, block.java);
      }
    }
    const javaAt = new Map(commands.commandBlocks.map(block => [site(block.dimension, block.pos), block.java]));
    for (const chain of commands.chains) {
      if (chain.status === "native") continue;
      const head = site(chain.head.dimension, chain.head.pos);
      const at = chain.at ? site(chain.at.dimension, chain.at.pos) : head;
      const where = (chain.blocks.length > 1 ? `${head} から ${chain.blocks.length} 個のチェーン` : head) + (at === head ? "" : `（該当: ${at}）`);
      if (chain.status === "runtime") add("chain", "info", where, "", javaAt.get(at),
        { code: "CHAIN_RUNTIME", message: "BE のコマンド 1 個にできない命令があり、チェーン全体をランタイムで実行する（BE での動作は確認していない）" });
      else add("chain", "action", where, chain.reason, javaAt.get(at));
    }
  }
  for (const d of report.datapacks.diagnostics) {
    const range = d.start !== undefined && d.end !== undefined ? `（${d.start + 1}〜${d.end} 文字目）` : "";
    add("datapack", "action", `${d.pack}${d.path ? ` ${d.path}` : ""}${range}`, d.reason, d.command);
    if (d.error) warnings[warnings.length - 1]!.detail = d.error;
  }
  for (const dir of report.datapacks.omitted) {
    add("datapack", "caution", "有効なデータパック全体", "", `data/<名前空間>/${dir}/`, FUNCTION_DIRECTORY.test(dir)
      ? { code: "DP_FUNCTION_DIRECTORY", message: `パックの版では読まれないディレクトリ名（${dir}）の関数・タグは同梱していない`, remedy: "Java 側で、パックの版に合うディレクトリ名（1.21 以降は function、それより前は functions）か確かめる" }
      : { code: "DP_OMITTED", message: `${dir} は移植の対象外で、BE ワールドに入れていない` });
  }
  const entity = (e: ReportEntity): string => e.pos ? site(e.dimension, [e.pos.x, e.pos.y, e.pos.z]) : `${e.dimension}（位置不明）`;
  const label = (e: ReportEntity, field?: string): string => `${e.type}${e.uuid ? `（UUID ${e.uuid}）` : ""}${field ? ` の ${field}` : ""}`;
  for (const e of report.entities.skipped) add("entity", "action", entity(e), e.reason, label(e));
  for (const e of report.entities.fields) add("entity", "caution", entity(e), e.reason, label(e, e.field));
  for (const s of report.scores.skipped) add("score", "caution", `スコア ${s.objective}`, s.reason, `参加者 ${s.participant}`);
  for (const s of report.storage.errors) add("storage", "action", `storage ${s.source}`, s.reason);
  return warnings;
}

type ReportEntity = ConvertReport["entities"]["skipped"][number];

export interface ReportContext {
  dataVersion?: number;
  /** 変換器の版（git のコミットなど） */
  converterVersion: string;
  /** 地形変換器（Chunker）の版 */
  chunkerVersion: string;
  /** ID 対応と既定状態の資材の Java の版 */
  mappingJavaVersion: string;
  mappingDataVersion?: number;
}

/** 実際に行った処理と、その結果から言える検査しなかった範囲。固定文にせず、変換結果から作る。 */
export function describeScope(report: ConvertReport, ctx: ReportContext): { processed: string[]; notChecked: string[] } {
  const processed: string[] = [];
  const notChecked: string[] = [];
  const c = report.commands;
  if (c) {
    const total = c.counts.rewritten + c.counts.unchanged + c.counts.unsupported + c.counts.invalid;
    const by = (s: string) => c.chains.filter(chain => chain.status === s).length;
    processed.push(`コマンドブロックのコマンド ${total} 個を確認した（BE の書き方に書き換え ${c.counts.rewritten}、そのまま ${c.counts.unchanged}、BE コマンド 1 個にできない ${c.counts.unsupported}、Java として読めない ${c.counts.invalid}）`);
    processed.push(`コマンドブロックのチェーン ${c.chains.length} 本を振り分けた（BE コマンドで実行 ${by("native")}、ランタイムで実行 ${by("runtime")}、未対応 ${by("unsupported")}）`);
    if (by("runtime")) notChecked.push("ランタイムで実行するチェーンの BE 上の動作");
  } else {
    notChecked.push("コマンドブロックのコマンド（書き換えを行っていない）");
  }
  processed.push(report.datapacks.functions || report.datapacks.diagnostics.length
    ? `データパックの関数 ${report.datapacks.functions} 個をランタイムパックに同梱した`
    : "有効なデータパックの関数はなかった");
  const omitted = report.datapacks.omitted.filter(dir => !FUNCTION_DIRECTORY.test(dir));
  if (omitted.length) notChecked.push(`データパックの関数・関数タグ以外の内容（${omitted.join("、")}）`);
  processed.push(`エンティティ ${report.entities.scheduled} 体を BE の初回読み込み時に再配置する（省いたもの ${report.entities.skipped.length} 体）`);
  if (report.entities.scheduled) notChecked.push("エンティティの再配置の成否（失敗はワールドのコンテンツログに出る）");
  processed.push(`スコアの目的 ${report.scores.objectives} 個・値 ${report.scores.participants} 件と storage ${report.storage.entries} 件を初期化パックに入れた`);
  processed.push("出力ワールドで Beta APIs とコマンド・コマンドブロックを有効にした");
  notChecked.push("チェーンどうし・関数どうしの状態の依存（実行順の前後関係）");
  notChecked.push("看板・本・ストラクチャーなど、コマンドブロック以外に書かれたコマンドやテキスト");
  notChecked.push("リソースパック（移植していない）");
  notChecked.push("ブロック・アイテムなど地形の変換結果（地形変換器 Chunker に任せている）");
  if (ctx.dataVersion !== ctx.mappingDataVersion) notChecked.push(`Java ${ctx.mappingJavaVersion} と異なる版のブロック・アイテムの差（ID の対応表は Java ${ctx.mappingJavaVersion} のもの）`);
  return { processed, notChecked };
}

const SEVERITY: Record<WarningSeverity, string> = { action: "要対応", caution: "注意", info: "情報" };
const AREA: Record<WarningArea, string> = {
  command_block: "コマンドブロック", chain: "コマンドブロックのチェーン", datapack: "データパック", entity: "エンティティ", score: "スコア", storage: "storage",
};

/** Markdown の表のセルに入れる。入力由来の文字列はコードとして出し、表を壊す文字を逃がす。 */
const flat = (text: string): string => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const cell = (text: string): string => flat(text).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const code = (text: string): string => { const body = flat(text); return body.includes("`") ? `\`\` ${body} \`\`` : `\`${body}\``; };

export function renderMarkdownReport(report: ConvertReport, warnings: readonly ReportWarning[], ctx: ReportContext): string {
  const { processed, notChecked } = describeScope(report, ctx);
  const count = (s: WarningSeverity) => warnings.filter(w => w.severity === s).length;
  const lines: string[] = [];
  lines.push("# 変換レポート", "");
  lines.push("Java 版のワールドを統合版（BE）に変換した結果です。変換できなかった箇所と理由を、Java 側の場所で示します。", "");
  lines.push("警告がない箇所も、BE で Java 版と同じように動くことを保証するものではありません。ゲーム内での確認はしていません。", "");
  lines.push("## 概要", "");
  lines.push(`- 入力の版: DataVersion ${ctx.dataVersion ?? "不明"}`);
  lines.push(`- 変換器の版: ${ctx.converterVersion}（地形変換器 Chunker ${ctx.chunkerVersion}、ID の対応表 Java ${ctx.mappingJavaVersion}）`);
  lines.push(`- 要対応: ${count("action")} 件、注意: ${count("caution")} 件、情報: ${count("info")} 件`);
  lines.push("", "### 検査した範囲", "");
  for (const p of processed) lines.push(`- ${p}`);
  lines.push("", "### 検査していない範囲", "");
  for (const n of notChecked) lines.push(`- ${n}`);
  const codes = new Map<string, number>();
  for (const w of warnings) codes.set(w.code, (codes.get(w.code) ?? 0) + 1);
  if (codes.size) {
    lines.push("", "### 警告コード別の件数", "", "| コード | 件数 |", "| --- | --- |");
    for (const [c, n] of [...codes].sort(([a], [b]) => a.localeCompare(b))) lines.push(`| ${c} | ${n} |`);
  }
  lines.push("", "## 詳細", "");
  if (!warnings.length) lines.push("警告はありません。");
  for (const severity of ["action", "caution", "info"] as const) {
    for (const area of Object.keys(AREA) as WarningArea[]) {
      const group = warnings.filter(w => w.severity === severity && w.area === area);
      if (!group.length) continue;
      lines.push(`### ${SEVERITY[severity]}: ${AREA[area]}（${group.length} 件）`, "");
      lines.push("| どこが | 何が | なぜ | 対処 | コード |", "| --- | --- | --- | --- | --- |");
      for (const w of group) {
        const why = w.detail && isJapanese(w.detail) && w.detail !== w.message ? `${w.message}（詳細: ${w.detail}）` : w.message;
        lines.push(`| ${cell(w.where)} | ${w.what ? code(w.what) : "—"} | ${cell(why)} | ${cell(w.remedy)} | ${w.code} |`);
      }
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}
