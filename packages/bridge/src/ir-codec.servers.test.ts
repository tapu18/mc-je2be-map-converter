// Node test using the server-generated grammar; no server process is needed.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { CommandParser, deserializeCommandIR, serializeCommandIR, toCommandIR, type CommandTreeNode } from "@je2be/core";
import { paths } from "./paths.ts";
import { loadScenarios } from "./scenario/load.ts";
import type { Action } from "./scenario/types.ts";

it("round trips all Java scenario commands with the generated grammar", () => {
  const parser = new CommandParser(JSON.parse(readFileSync(paths.commandsReport, "utf8")) as CommandTreeNode, {textFormat: "snbt"});
  const commands: string[] = [];
  const actions = (items: Action[] = []) => items.forEach(a => {
    if ("run" in a) commands.push(a.run);
    if ("commandBlocks" in a) commands.push(...a.commandBlocks.map(b => b.command));
  });
  for (const s of loadScenarios()) {
    commands.push(...s.setup);
    actions(s.actions); actions(s.play);
    for (const lines of Object.values(s.datapack?.functions ?? {})) commands.push(...lines.filter(line => line.trim() && !line.trimStart().startsWith("#") && !line.startsWith("$")));
  }
  let bytes = 0;
  for (const source of commands) {
    const parsed = parser.parse(source);
    if (!parsed.ok) throw new Error(`${source}: ${parsed.error.message} at ${parsed.error.position}`);
    const document = {grammarVersion: "26.3", textFormat: "snbt" as const, ir: toCommandIR(source, parsed.nodes)};
    const json = serializeCommandIR(document);
    bytes += Buffer.byteLength(json);
    expect(deserializeCommandIR(json), source).toEqual({ok: true, document});
  }
  expect(commands.length).toBeGreaterThan(0);
  console.log(`scenario IR: ${commands.length} commands, ${bytes} UTF-8 bytes`);
});
