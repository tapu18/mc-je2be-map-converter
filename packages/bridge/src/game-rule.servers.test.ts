import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommandParser, gameRuleByJavaName, gameRules, rewriteCommand, type RewriteContext } from "@je2be/core";
import { javaGrammarSources, loadGrammarTree, loadRewriteContext, setupJavaGrammar } from "@je2be/converter";
import { BedrockServer, rewriteResources } from "./index.ts";

describe("game rule rewrite against fixed Java grammars and BDS", () => {
  let modern: RewriteContext;
  let legacy: RewriteContext;
  let bds: BedrockServer;

  beforeAll(async () => {
    modern = loadRewriteContext(await rewriteResources(), "snbt");
    const old = await setupJavaGrammar(javaGrammarSources().find(source => source.version === "1.21.10")!);
    legacy = { ...modern, parser: new CommandParser(loadGrammarTree(old), old) };
    bds = await BedrockServer.start({ tickingArea: false });
  });
  afterAll(async () => { await bds?.stop(); });

  function convert(command: string, ctx: RewriteContext): string {
    const result = rewriteCommand(command, ctx);
    expect(result, command).toHaveProperty("command");
    if (!("command" in result)) throw new Error(JSON.stringify(result));
    return result.command;
  }

  function consoleReply(command: string, matches: (line: string) => boolean): Promise<string> {
    const from = bds.log.length;
    bds.console(command);
    return bds.waitForLog(line => matches(line) && bds.log.slice(from).includes(line), 5000, command);
  }

  function readValue(name: string, expected: string): Promise<string> {
    return consoleReply(`gamerule ${name}`, line => line.toLowerCase().endsWith(`] ${name.toLowerCase()} = ${expected}`));
  }

  function listRules(): Promise<string> {
    return consoleReply("gamerule", line => line.includes("commandBlockOutput = ") && line.includes(", "));
  }

  it("matches the Java 1.21.10 and 26.3 names and value types", () => {
    const report = (ctx: RewriteContext) => ctx.parser.root.children!.gamerule!.children!;
    const legacyNames = new Set<string>();
    for (const [id, rule] of gameRules) {
      for (const modernName of [id, `minecraft:${id}`]) {
        expect(Object.values(report(modern)[modernName]?.children ?? {}).map(node => node.parser), modernName)
          .toEqual([`brigadier:${rule.javaType}`]);
      }
      legacyNames.add(rule.legacy);
    }
    legacyNames.add("doFireTick");
    expect([...legacyNames].sort()).toEqual(Object.keys(report(legacy)).sort());
    for (const name of legacyNames) {
      expect(Object.values(report(legacy)[name]!.children!).map(node => node.parser), name)
        .toEqual([`brigadier:${gameRuleByJavaName(name)!.rule.javaType}`]);
    }
  });

  it("sets and reads back each supported boolean and integer from both Java name forms", async () => {
    const listed = await listRules();
    for (const [id, rule] of gameRules) {
      const target = rule.bedrock;
      if (!target || target.type === "waypoints") continue;
      const name = target.name;
      const defaultValue = listed.match(new RegExp(`\\b${name} = ([^,]+)`, "i"))?.[1];
      expect(defaultValue, name).toMatch(target.type === "bool" ? /^(true|false)$/ : /^-?\d+$/);
      const oldValue = target.type === "bool" ? String(defaultValue === "false") : "7";
      const newValue = target.type === "bool" ? defaultValue! : "8";

      for (const [sourceName, value, ctx] of [[rule.legacy, oldValue, legacy], [`minecraft:${id}`, newValue, modern]] as const) {
        const set = convert(`gamerule ${sourceName} ${value}`, ctx);
        expect(set).toBe(`gamerule ${name} ${value}`);
        expect(await bds.exec(set), set).toMatchObject({ ok: true, result: { successCount: 1 } });
        expect(convert(`gamerule ${sourceName}`, ctx)).toBe(`gamerule ${name}`);
        await readValue(name, value);
      }
    }
    expect(convert("execute run gamerule random_tick_speed 9", modern)).toBe("execute run gamerule randomTickSpeed 9");
    expect(convert("gamerule pvp false", legacy)).toBe("gamerule pvp false");

    const fire = convert("gamerule doFireTick false", legacy);
    expect(await bds.exec(fire), fire).toMatchObject({ ok: true, result: { successCount: 1 } });
    await readValue("doFireTick", "false");
  });

  it("translates the locator toggle and reports the unavailable named query", async () => {
    for (const [command, expected, ctx] of [
      ["gamerule locatorBar false", "off", legacy],
      ["gamerule locator_bar true", "everyone", modern],
    ] as const) {
      const set = convert(command, ctx);
      expect(set).toBe(`gamerule playerWaypoints ${expected}`);
      expect(await bds.exec(set)).toMatchObject({ ok: true, result: { successCount: 1 } });
      expect(await listRules()).toContain(`playerWaypoints = ${expected}`);
    }
    expect(await bds.exec("gamerule playerWaypoints")).toMatchObject({ ok: false });
    expect(rewriteCommand("gamerule locator_bar", modern)).toMatchObject({
      status: "unsupported", issues: [{ message: expect.stringContaining("名前指定で照会できない") }],
    });
  });

  it("reports missing rules, mismatched rules and values outside the Bedrock range", async () => {
    const listed = await listRules();
    for (const [id, rule] of gameRules) {
      if (rule.bedrock) continue;
      const setting = rule.javaType === "bool" ? "true" : "1";
      expect(rewriteCommand(`gamerule minecraft:${id} ${setting}`, modern), id).toMatchObject({
        status: "unsupported", issues: [{ message: expect.stringContaining(rule.difference ?? "BE に対応するゲームルールがない") }],
      });
      expect(rewriteCommand(`gamerule ${rule.legacy}`, legacy), rule.legacy).toMatchObject({ status: "unsupported" });
      if (!rule.difference) expect(listed.toLowerCase()).not.toContain(`${rule.legacy.toLowerCase()} = `);
    }
    expect(listed).toContain("maxCommandChainLength = ");
    expect(listed).toContain("doFireTick = ");
    expect(listed).toContain("showRecipeMessages = ");
    expect(await bds.exec("gamerule spawnMonsters")).toMatchObject({ ok: false });

    for (const [java, bedrock, invalid, max] of [
      ["random_tick_speed", "randomTickSpeed", 4097, 4096],
      ["respawn_radius", "spawnRadius", 129, 128],
    ] as const) {
      for (const value of [-1, invalid]) {
        expect(rewriteCommand(`gamerule ${bedrock} ${value}`, legacy)).toMatchObject({
          status: "unsupported", issues: [{ message: expect.stringContaining(`Java 側で指定値をこの範囲に収める`) }],
        });
        expect(await bds.exec(`gamerule ${bedrock} ${value}`)).toMatchObject({ ok: true, result: { successCount: 0 } });
      }
      expect(rewriteCommand(`gamerule ${java} ${invalid}`, modern)).toMatchObject({ status: "unsupported" });
      expect(await bds.exec(convert(`gamerule ${java} ${max}`, modern))).toMatchObject({ ok: true, result: { successCount: 1 } });
      await readValue(bedrock, String(max));
    }
  });
});
