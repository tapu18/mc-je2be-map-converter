import { describe, expect, it } from "vitest";
import { CommandParser } from "@je2be/core";
import { javaGrammarSources, loadGrammarTree, setupJavaGrammar } from "@je2be/converter";
import { JavaServer } from "./java.ts";

describe("the Java 1.20.5 item component boundary", () => {
  for (const version of ["1.20.4", "1.20.5"]) {
    it(`reads the same custom item field and retains it in a hover on Java ${version}`, async () => {
      const grammar = await setupJavaGrammar(javaGrammarSources().find(source => source.version === version)!);
      const legacy = version === "1.20.4";
      const item = legacy ? "stone{foo:1b,other:2b}" : "stone[custom_data={foo:1b,other:2b}]";
      const path = legacy ? "Items[{Slot:0b}].tag.foo" : 'Items[{Slot:0b}].components."minecraft:custom_data".foo';
      const write = `item replace block 2 -60 2 container.0 with ${item}`;
      const read = `data get block 2 -60 2 ${path}`;
      const contents = legacy ? { id: "stone", tag: "{foo:1b}" } : { id: "stone", components: { "minecraft:custom_data": { foo: true } } };
      const hover = JSON.stringify({ text: "item", hoverEvent: { action: "show_item", contents } });
      const parser = new CommandParser(loadGrammarTree(grammar), grammar);
      const predicate = legacy ? "stone{foo:1b}" : "stone[custom_data~{foo:1b}]";
      for (const command of [write, read, `clear @a ${predicate}`, `tellraw @a ${hover}`]) {
        expect(parser.parse(command).ok).toBe(true);
      }

      const server = await JavaServer.start({ runtime: grammar, forceload: [0, 0, 15, 15] });
      try {
        expect(await server.exec("setblock 2 -60 2 minecraft:chest")).toMatch(/Changed the block/);
        expect(await server.exec(write)).toMatch(/Replaced/);
        expect(await server.exec(read)).toMatch(/: 1b$/);
        if (!legacy) {
          const count = await server.exec(`execute if items block 2 -60 2 container.0 ${predicate}`);
          expect(count).toMatch(/Test passed/);
        }
        expect(await server.exec(`summon minecraft:text_display 2 -59 2 {Tags:["hover_probe"],text:${JSON.stringify(hover)}}`)).toMatch(/Summoned/);
        const text = await server.exec("data get entity @e[type=text_display,tag=hover_probe,limit=1] text");
        expect(text).toContain("show_item");
        expect(text).toContain("foo");
      } finally {
        await server.stop();
      }
    });
  }
});
