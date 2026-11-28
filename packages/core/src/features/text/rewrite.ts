import type { NbtTag } from "../../nbt/nbt.ts";
import { formatRawText, toRawText, type RawTextOptions } from "./rawtext.ts";

interface TextEditor {
  replace(start: number, end: number, text: string): void;
  unsupported(message: string): void;
  warn(message: string): void;
}

/** テキストの節を rawtext に差し替える。落ちる成分は警告、BE にない成分は unsupported として編集器に伝える */
export function rewriteTextNode(node: { start: number; end: number }, value: NbtTag, opts: RawTextOptions, ed: TextEditor): void {
  const r = toRawText(value, opts);
  for (const i of r.issues) (i.severity === "unsupported" ? ed.unsupported(i.message) : ed.warn(i.message));
  ed.replace(node.start, node.end, formatRawText(r.rawtext));
}

/** テキストを出す title（title・subtitle・actionbar）は BE では titleraw。times・clear・reset は title のまま */
export function rewriteTitleHead(display: string | undefined, head: { start: number; end: number }, ed: TextEditor): void {
  if (display === "title" || display === "subtitle" || display === "actionbar") ed.replace(head.start, head.end, "titleraw");
}
