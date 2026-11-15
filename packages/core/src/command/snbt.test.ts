import { describe, expect, it } from "vitest";
import { CommandSyntaxError } from "./reader.ts";
import { parseSnbt } from "./snbt.ts";

describe("parseSnbt", () => {
  it("数値の接尾辞", () => {
    expect(parseSnbt("1b")).toEqual({ type: "byte", value: 1 });
    expect(parseSnbt("2s")).toEqual({ type: "short", value: 2 });
    expect(parseSnbt("3")).toEqual({ type: "int", value: 3 });
    expect(parseSnbt("4L")).toEqual({ type: "long", value: 4n });
    expect(parseSnbt("1.5f")).toEqual({ type: "float", value: 1.5 });
    expect(parseSnbt("2d")).toEqual({ type: "double", value: 2 });
    expect(parseSnbt("2.5")).toEqual({ type: "double", value: 2.5 });
    expect(parseSnbt(".5")).toEqual({ type: "double", value: 0.5 });
    expect(parseSnbt("1e3")).toEqual({ type: "double", value: 1000 });
  });

  it("1.21.5 以降の整数の書き方（16進、区切り、符号の接尾辞）", () => {
    expect(parseSnbt("0x1F")).toEqual({ type: "int", value: 31 });
    expect(parseSnbt("1_000")).toEqual({ type: "int", value: 1000 });
    expect(parseSnbt("5ub")).toEqual({ type: "byte", value: 5 });
  });

  it("真偽値と bool() / uuid()", () => {
    expect(parseSnbt("true")).toEqual({ type: "byte", value: 1 });
    expect(parseSnbt("bool(0)")).toEqual({ type: "byte", value: 0 });
    expect(parseSnbt('uuid("0-0-0-0-1")')).toEqual({ type: "intArray", value: Int32Array.from([0, 0, 0, 1]) });
  });

  it("文字列とエスケープ", () => {
    expect(parseSnbt("abc")).toEqual({ type: "string", value: "abc" });
    expect(parseSnbt("'a\"b'")).toEqual({ type: "string", value: 'a"b' });
    expect(parseSnbt('"a\\nb"')).toEqual({ type: "string", value: "a\nb" });
    expect(parseSnbt('"\\u3042"')).toEqual({ type: "string", value: "あ" });
  });

  it("複合タグ、リスト、配列（末尾のカンマを許す）", () => {
    const t = parseSnbt('{a:1b,"b c":[1,2,],d:[I;1,2],e:{},}');
    expect(t.type).toBe("compound");
    if (t.type !== "compound") return;
    expect([...t.value.keys()]).toEqual(["a", "b c", "d", "e"]);
    expect(t.value.get("b c")).toEqual({ type: "list", elementType: "int", value: [{ type: "int", value: 1 }, { type: "int", value: 2 }] });
    expect(t.value.get("d")).toEqual({ type: "intArray", value: Int32Array.from([1, 2]) });
  });

  it("型の混ざったリストは複合タグに包む", () => {
    expect(parseSnbt('[1,"a"]')).toEqual({
      type: "list",
      elementType: "compound",
      value: [
        { type: "compound", value: new Map([["", { type: "int", value: 1 }]]) },
        { type: "compound", value: new Map([["", { type: "string", value: "a" }]]) },
      ],
    });
  });

  it("JSON のテキストも読める", () => {
    const t = parseSnbt('["",{"text":"a","bold":true,"extra":[{"text":"b"}]}]');
    expect(t).toMatchObject({ type: "list" });
  });

  it("区切りのない複合タグは失敗する", () => {
    expect(() => parseSnbt("{a:1 b:2}")).toThrow(CommandSyntaxError);
    expect(() => parseSnbt("{a:1")).toThrow(CommandSyntaxError);
    expect(() => parseSnbt('uuid("x")')).toThrow(CommandSyntaxError);
  });
});
