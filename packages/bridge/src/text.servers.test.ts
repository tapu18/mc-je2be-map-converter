// tellraw・title のテキストを成分の種類・書式ごとに書き換え、BDS で成功件数を確かめる（#347）。
// - 入力は Java 26.3 が文法として受理する（checkJavaSyntax）
// - 書き換えた BE のコマンドは、試験用プレイヤー1人に対して BDS の successCount が 1 になる
// - BE の rawtext に移せない成分（nbt・keybind）は unsupported、落とす書式は警告になる
// 見た目（色・書式が同じに見えるか）は比べない（層4、#114）。成分の頻度は docs/text-components.md。
import { beforeAll, describe, expect, it } from "vitest";
import { nbtTextRuntimeReason, rewriteCommand, type RewriteContext } from "@je2be/core";
import { loadRewriteContext } from "@je2be/converter";
import { checkJavaSyntax, rewriteResources } from "./index.ts";
import { withSimulatedPlayer } from "./simulated-player.ts";

const P = "Reader";

/** [種類・書式, Java のコマンド, 期待する警告の一部（なければ空）] */
const CASES: [string, string, string[]][] = [
  ["text: string", `tellraw @a "plain"`, []],
  ["text: compound", `tellraw @a {text:"x"}`, []],
  ["text: list", `tellraw @a ["a",{text:"b"},"c"]`, []],
  ["text: title", `title @a title {text:"t"}`, []],
  ["text: subtitle", `title @a subtitle {text:"s"}`, []],
  ["text: actionbar", `title @a actionbar {text:"a"}`, []],
  ["translate", `tellraw @a {translate:"chat.type.text"}`, ["翻訳キー"]],
  ["translate: with", `tellraw @a {translate:"chat.type.text",with:["a",{text:"b",color:"blue"}]}`, ["翻訳キー"]],
  ["translate: with score", `tellraw @a {translate:"chat.type.text",with:[{score:{name:"${P}",objective:"t"}},"b"]}`, ["翻訳キー"]],
  ["translate: unknown key", `tellraw @a {translate:"je2be.unknown.key"}`, ["翻訳キー"]],
  ["translate: fallback", `tellraw @a {translate:"je2be.unknown.key",fallback:"fb"}`, ["翻訳キー"]],
  ["score: name", `tellraw @a {score:{name:"${P}",objective:"t"}}`, []],
  ["score: fake player", `tellraw @a {score:{name:"#g",objective:"t"}}`, []],
  ["score: *", `tellraw @a {score:{name:"*",objective:"t"}}`, []],
  ["score: @s", `execute as @a run tellraw @s {score:{name:"@s",objective:"t"}}`, []],
  ["score: @p", `tellraw @a {score:{name:"@p",objective:"t"}}`, []],
  ["score: unset", `tellraw @a {score:{name:"nobody",objective:"t"}}`, []],
  ["score: missing objective", `tellraw @a {score:{name:"${P}",objective:"missing"}}`, []],
  ["selector: @a", `tellraw @a {selector:"@a"}`, []],
  ["selector: type", `tellraw @a {selector:"@e[type=minecraft:pig,limit=1,sort=nearest]"}`, []],
  ["selector: no match", `tellraw @a {selector:"@e[type=minecraft:cow]"}`, []],
  ["selector: separator", `tellraw @a {selector:"@a",separator:", "}`, ["separator"]],
  ["color", `tellraw @a {text:"x",color:"red"}`, []],
  ["color_hex", `tellraw @a {text:"x",color:"#FF5050"}`, ["16進の色"]],
  ["bold", `tellraw @a {text:"x",bold:true}`, []],
  ["italic", `tellraw @a {text:"x",italic:true}`, []],
  ["underlined", `tellraw @a {text:"x",underlined:true}`, []],
  ["strikethrough", `tellraw @a {text:"x",strikethrough:true}`, []],
  ["obfuscated", `tellraw @a {text:"x",obfuscated:true}`, []],
  ["font", `tellraw @a {text:"x",font:"minecraft:uniform"}`, ["font"]],
  ["insertion", `tellraw @a {text:"x",insertion:"i"}`, ["insertion"]],
  ["shadow_color", `tellraw @a {text:"x",shadow_color:-1}`, ["shadow_color"]],
  ["click", `tellraw @a {text:"x",click_event:{action:"run_command",command:"/say hi"}}`, ["click_event"]],
  ["hover", `tellraw @a {text:"x",hover_event:{action:"show_text",value:"h"}}`, ["hover_event"]],
  ["extra: depth 2", `tellraw @a {text:"a",color:"gold",extra:[{text:"b",bold:true,extra:[{score:{name:"${P}",objective:"t"}},{text:"c",color:"white"}]}]}`, []],
  ["extra: mixed list", `tellraw @a ["",{text:"a",color:"red"},{selector:"@a"}," ",{score:{name:"${P}",objective:"t"}}]`, []],
];

/** 変換器の文法では読めるが、Java 26.3 のサーバーが拒否するもの */
const JAVA_REJECTED = [`tellraw @a 12`, `tellraw @a {text:"c",color:"reset"}`];

/** BE の rawtext に移せないもの（理由の一部） */
const UNSUPPORTED: [string, string, string][] = [
  ["nbt: storage", `tellraw @a {nbt:"v",storage:"je2be:t"}`, nbtTextRuntimeReason],
  ["nbt: entity", `tellraw @a {nbt:"Pos",entity:"@s"}`, nbtTextRuntimeReason],
  ["nbt: block", `title @a actionbar {nbt:"Items",block:"0 0 0"}`, nbtTextRuntimeReason],
  ["keybind", `tellraw @a {keybind:"key.jump"}`, "keybind"],
  ["score: unconvertible selector", `tellraw @a {score:{name:"@e[team=red,limit=1]",objective:"t"}}`, "score の対象のセレクタ"],
];

/** BE の rawtext に直接書いた形（変換器は出さない）。BE が受け付けるかと成功件数を記録する。[名前, BE のコマンド, successCount] */
const BEDROCK_PROBES: [string, string, number][] = [
  ["rawtext: empty", `tellraw @a {"rawtext":[]}`, 1],
  ["rawtext: unknown part key", `tellraw @a {"rawtext":[{"keybind":"key.jump"}]}`, 1],
  ["rawtext: Java style key", `tellraw @a {"rawtext":[{"text":"x","color":"red"}]}`, 1],
  ["rawtext: Java nbt part", `tellraw @a {"rawtext":[{"nbt":"v","storage":"je2be:t"}]}`, 1],
  ["rawtext: with string array", `tellraw @a {"rawtext":[{"translate":"%%s and %%s","with":["a","b"]}]}`, 1],
  ["titleraw: unknown part key", `titleraw @a actionbar {"rawtext":[{"keybind":"key.jump"}]}`, 1],
  ["rawtext: Java component", `tellraw @a {"text":"x"}`, 0],
];

describe("text components on BDS", () => {
  let ctx: RewriteContext;
  beforeAll(async () => { ctx = loadRewriteContext(await rewriteResources(), "snbt"); });

  it("uses inputs that Java 26.3 accepts", async () => {
    const inputs = [...CASES, ...UNSUPPORTED].map(([, java]) => java);
    expect((await checkJavaSyntax([...inputs, ...JAVA_REJECTED])).filter(r => !r.ok).map(r => r.command)).toEqual(JAVA_REJECTED);
  });

  it("rewrites each kind and style, and BDS succeeds once for the one player", async () => {
    for (const [label, java, warnings] of CASES) {
      const r = rewriteCommand(java, ctx);
      expect(r, label).toMatchObject({ status: "rewritten" });
      if (r.status !== "rewritten") continue;
      expect(r.issues.map(i => i.message), label).toEqual(warnings.map(w => expect.stringContaining(w)));
    }
    for (const [label, java, reason] of UNSUPPORTED) {
      expect(rewriteCommand(java, ctx), label).toMatchObject({ status: "unsupported", issues: expect.arrayContaining([{ severity: "unsupported", message: expect.stringContaining(reason) }]) });
    }
    await withSimulatedPlayer(P, async (bds) => {
      for (const c of ["scoreboard objectives add t dummy", `scoreboard players set ${P} t 7`, 'scoreboard players set "#g" t 3', "summon pig 8 -60 8"]) {
        expect(await bds.exec(c), c).toMatchObject({ ok: true });
      }
      const counts: Record<string, unknown> = {};
      const expected: Record<string, unknown> = {};
      for (const [label, java] of CASES) {
        const r = rewriteCommand(java, ctx);
        if (r.status !== "rewritten") continue;
        const res = await bds.exec(r.command);
        counts[label] = res.ok ? res.result?.successCount : res.error;
        expected[label] = 1;
      }
      // successCount は受け取ったプレイヤーの数で、成分の中身（未知のキー、ない目的、一致しないセレクタ）では変わらない
      for (const [label, be, count] of BEDROCK_PROBES) {
        const res = await bds.exec(be);
        counts[label] = res.ok ? res.result?.successCount : res.error;
        expected[label] = count;
      }
      // 対象がいなければ失敗する（成功件数が受け手の数であることの対照）
      const none = await bds.exec(`tellraw @e[type=cow] {"rawtext":[{"text":"x"}]}`);
      counts["no recipient"] = none.ok ? none.result?.successCount : "error";
      expected["no recipient"] = "error";
      expect(counts).toEqual(expected);
    });
  });
});
