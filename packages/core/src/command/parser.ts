// コマンドのパーサ（design.md 5.2、#13）。
// 文法は Java 版サーバーのデータ生成（`--reports`）が出す commands.json の木をそのまま使い、
// Brigadier と同じ規則でたどる：次の語に一致するリテラルがあればそれだけを試し、なければ引数を順に試す。
// 引数の後ろは空白1つか文字列の終わり。`redirect` のある節は、行き先の子へ続く。
// 子も `redirect` も持たず実行もできない節（`execute ... run`）は、木の根へ続く（commands.json は根への redirect を書かない）。
import { ARGUMENT_PARSERS, type ArgumentOptions, type ArgumentValue } from "./arguments.ts";
import { CommandSyntaxError, StringReader } from "./reader.ts";

/** commands.json の節 */
export interface CommandTreeNode {
  type: "root" | "literal" | "argument";
  children?: Record<string, CommandTreeNode>;
  executable?: boolean;
  redirect?: string[];
  parser?: string;
  properties?: Record<string, unknown>;
}

export interface ParsedNode {
  kind: "literal" | "argument";
  /** リテラルはその語、引数は commands.json での引数名 */
  name: string;
  parser?: string;
  start: number;
  end: number;
  /** 引数の値（リテラルにはない） */
  value?: ArgumentValue;
  /**
   * この節の直前で木のどこへ飛んだか。`execute` はサブコマンドの区切り、`root` は `run` の先
   */
  jump?: "execute" | "root";
}

export interface ParseError {
  message: string;
  /** 文字列の何文字目で失敗したか（最も先まで読めた候補の位置） */
  position: number;
  /** 失敗した引数の型（リテラルの不一致なら undefined） */
  parser?: string;
}

export type ParseResult = { ok: true; nodes: ParsedNode[] } | { ok: false; error: ParseError };

export interface ParseOptions extends ArgumentOptions {}

export class CommandParser {
  readonly root: CommandTreeNode;
  readonly options: ParseOptions;

  constructor(root: CommandTreeNode, options: ParseOptions) {
    this.root = root;
    this.options = options;
  }

  private resolve(path: string[]): CommandTreeNode {
    let node = this.root;
    for (const name of path) {
      const next = node.children?.[name];
      if (!next) throw new Error(`commands.json の redirect 先がない: ${path.join(" ")}`);
      node = next;
    }
    return node;
  }

  /** 先頭の `/` は取り除く（コマンドブロックでは書いてもよい） */
  parse(command: string): ParseResult {
    const input = command.startsWith("/") ? command.slice(1) : command;
    const offset = command.length - input.length;
    const best: { error: ParseError | undefined } = { error: undefined };
    const nodes = this.walk(new StringReader(input), this.root, [], best, undefined);
    if (nodes) return { ok: true, nodes: nodes.map((n) => ({ ...n, start: n.start + offset, end: n.end + offset })) };
    const error = best.error ?? { message: "空のコマンド", position: 0 };
    return { ok: false, error: { ...error, position: error.position + offset } };
  }

  private fail(best: { error: ParseError | undefined }, error: ParseError): undefined {
    if (!best.error || error.position >= best.error.position) best.error = error;
    return undefined;
  }

  /** node の子を、reader の位置から読む。読み切れたら節の並びを返す */
  private walk(
    r: StringReader,
    node: CommandTreeNode,
    path: ParsedNode[],
    best: { error: ParseError | undefined },
    jump: ParsedNode["jump"],
  ): ParsedNode[] | undefined {
    const children = node.children ?? {};
    const start = r.cursor;
    const nextWord = r.input.slice(start, r.input.indexOf(" ", start) < 0 ? undefined : r.input.indexOf(" ", start));
    const literal = children[nextWord];
    const candidates: [string, CommandTreeNode][] =
      literal?.type === "literal" ? [[nextWord, literal]] : Object.entries(children).filter(([, c]) => c.type === "argument");
    if (candidates.length === 0) {
      return this.fail(best, { message: nextWord ? `不明なコマンドかサブコマンド '${nextWord}'` : "引数が足りない", position: start });
    }
    for (const [name, child] of candidates) {
      r.cursor = start;
      let parsed: ParsedNode;
      if (child.type === "literal") {
        r.cursor = start + name.length;
        parsed = { kind: "literal", name, start, end: r.cursor };
      } else {
        const parser = ARGUMENT_PARSERS[child.parser ?? ""];
        if (!parser) {
          this.fail(best, { message: `未対応の引数の型 '${child.parser}'`, position: start, ...(child.parser ? { parser: child.parser } : {}) });
          continue;
        }
        try {
          const value = parser(r, child.properties, this.options);
          parsed = { kind: "argument", name, parser: child.parser as string, start, end: r.cursor, value };
        } catch (e) {
          if (!(e instanceof CommandSyntaxError)) throw e;
          this.fail(best, { message: e.message, position: e.position, parser: child.parser as string });
          continue;
        }
        if (r.canRead() && r.peek() !== " ") {
          this.fail(best, { message: `引数の後ろに余分な文字 '${r.peek()}'`, position: r.cursor, parser: child.parser as string });
          continue;
        }
      }
      if (jump) parsed.jump = jump;
      const here = [...path, parsed];
      // 末尾の空白は読み飛ばす（Java のコマンドブロックで末尾の空白が許されるかは未確認、#13）
      if (!r.canRead() || r.remaining().trim() === "") {
        if (child.executable) return here;
        this.fail(best, { message: "コマンドが途中で終わっている", position: r.input.length });
        continue;
      }
      r.skip(); // 区切りの空白
      let next: CommandTreeNode = child;
      let nextJump: ParsedNode["jump"];
      if (child.redirect) {
        next = this.resolve(child.redirect);
        nextJump = child.redirect.length === 1 && child.redirect[0] === "execute" ? "execute" : undefined;
      } else if (!child.children && !child.executable) {
        next = this.root;
        nextJump = "root";
      }
      const result = this.walk(r, next, here, best, nextJump);
      if (result) return result;
    }
    return undefined;
  }
}

// ---- 中間表現 ----

/** `execute` のサブコマンド1つ（as、at、positioned、if、store など） */
export interface ExecuteStep {
  /** サブコマンドの名前（`as`、`if` など） */
  kind: string;
  /** サブコマンドの名前に続くリテラルと引数（`if score` なら `score` から） */
  nodes: ParsedNode[];
}

export interface CommandIR {
  /** 元の文字列 */
  source: string;
  /** `execute` のサブコマンドを、書かれた順に並べたもの。入れ子の `execute ... run execute ...` も平らにする */
  context: ExecuteStep[];
  /**
   * 最後に実行するコマンド（`run` の先、または execute でないコマンド）。
   * `execute if ...` のように run なしで終わるときは undefined
   */
  command?: { name: string; nodes: ParsedNode[] };
}

/** パースした節の並びを、実行コンテキストと最後のコマンドに分ける */
export function toCommandIR(source: string, nodes: ParsedNode[]): CommandIR {
  const context: ExecuteStep[] = [];
  let command: CommandIR["command"];
  let i = 0;
  while (i < nodes.length) {
    const head = nodes[i] as ParsedNode;
    // 区切り（次の jump）までを1つの塊にする
    let j = i + 1;
    while (j < nodes.length && !(nodes[j] as ParsedNode).jump) j++;
    const group = nodes.slice(i, j);
    if (head.kind === "literal" && head.name === "execute" && head.jump !== "execute") {
      // `execute` だけの塊のあとに、サブコマンドの塊が続く
      if (group.length > 1) {
        const [sub, ...rest] = group.slice(1) as [ParsedNode, ...ParsedNode[]];
        pushStep(context, sub, rest);
      }
    } else if (head.jump === "execute") {
      const [sub, ...rest] = group as [ParsedNode, ...ParsedNode[]];
      pushStep(context, sub, rest);
    } else {
      command = { name: head.name, nodes: group.slice(1) };
    }
    i = j;
  }
  return command ? { source, context, command } : { source, context };
}

function pushStep(context: ExecuteStep[], sub: ParsedNode, rest: ParsedNode[]): void {
  // `run` は区切りでしかないので、サブコマンドとしては残さない
  if (sub.name === "run" && rest.length === 0) return;
  context.push({ kind: sub.name, nodes: rest });
}
