// #15: private JSONL in, aggregate JSON out. Never print command text or author IDs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CommandParser, selectCommandGrammar, toCommandIR, type RewriteContext, type NbtPathNode, type NbtTag } from "@je2be/core";
import { loadJavaGrammars, loadGrammarTree, loadRewriteContext, staticCommandCoverage } from "@je2be/converter";

// Explicit publication vocabulary. Anything else (including every storage key) is redacted.
const keys = new Set("Pos Motion Rotation Health HurtTime DeathTime Air Fire FallDistance OnGround NoGravity Invulnerable Silent Glowing Tags UUID CustomName CustomNameVisible PersistenceRequired ArmorItems HandItems ArmorDropChances HandDropChances Inventory EnderItems SelectedItem SelectedItemSlot Items Item Count count id Slot tag components minecraft:custom_data minecraft:custom_model_data CustomModelData Damage Unbreakable display Name Lore Enchantments lvl Attributes Base modifiers ActiveEffects active_effects amplifier duration ShowParticles show_particles Passengers vehicle Owner LeftHanded Small Invisible Marker NoBasePlate ShowArms Pose Head Body LeftArm RightArm LeftLeg RightLeg DisabledSlots Interaction width height response transformation translation scale left_rotation right_rotation text line_width background text_opacity shadow see_through alignment billboard brightness block_state item item_display interpolation_duration start_interpolation teleport_duration view_range shadow_radius shadow_strength Command auto powered conditionMet SuccessCount TrackOutput LastOutput UpdateLastExecution LastExecution Text1 Text2 Text3 Text4 front_text back_text messages color has_glowing_text Lock LootTable LootTableSeed RecordItem LastDeathLocation dimension pos".split(" "));
const safeKey = (key: string, storage: boolean) => !storage && keys.has(key) ? key : "<custom>";
export function publicPath(path: NbtPathNode[], storage = false): string {
  return path.map(p => p.kind === "key" ? `.${safeKey(p.key, storage)}` : p.kind === "filter" ? "{…}" : "[]").join("").replace(/^\./, "");
}
export function compoundPaths(tag: NbtTag, storage = false, prefix = ""): string[] {
  if (tag.type === "compound") {
    const entries = [...tag.value];
    if (!entries.length) return [prefix || "{…}"];
    return entries.flatMap(([key, value]) => compoundPaths(value, storage, prefix ? `${prefix}.${safeKey(key, storage)}` : safeKey(key, storage)));
  }
  if (tag.type === "list") return tag.value.length ? tag.value.flatMap(t => compoundPaths(t, storage, prefix + "[]")) : [prefix + "[]"];
  return [prefix];
}
export function functionSummary(rows: { function?: number; status: string }[]) {
  const functions = new Map<number, boolean>();
  for (const row of rows) if (row.function !== undefined) functions.set(row.function,
    (functions.get(row.function) ?? true) && ["unchanged", "rewritten"].includes(row.status));
  return { nonempty: functions.size, allLinesOutput: [...functions.values()].filter(Boolean).length };
}

function main(input: string) {
  const grammars = loadJavaGrammars();
  if (!grammars.length) throw new Error("Run setup:grammars first");
  const fixed = JSON.parse(readFileSync(new URL("./servers.json", import.meta.url), "utf8")) as { java: { version: string } };
  const root = fileURLToPath(new URL("../", import.meta.url));
  const base = loadRewriteContext({ commandsJson: `${root}servers/reports-${fixed.java.version}/reports/commands.json`,
    blocksJson: `${root}servers/reports-${fixed.java.version}/reports/blocks.json`, mappingsJson: `${root}servers/mappings/mappings.json` }, "snbt");
  const contexts = new Map<string, RewriteContext>();
  const counts: Record<string, number> = {};
  const paths = new Map<string, number>();
  const functions: { function?: number; status: string }[] = [];
  const inc = (key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
  const path = (category: string, value: string) => { const key = `${category}: ${value}`; paths.set(key, (paths.get(key) ?? 0) + 1); };
  for (const line of readFileSync(input, "utf8").split("\n").filter(Boolean)) {
    const row = JSON.parse(line) as { source: "cb" | "fn"; cmd: string; dataVersion: number | null; packFormat: number | null; function?: number };
    const selection = selectCommandGrammar(grammars, { ...(row.dataVersion === null ? {} : { dataVersion: row.dataVersion }), ...(row.packFormat === null ? {} : { packFormat: row.packFormat }) });
    let context: RewriteContext | undefined;
    if (selection.ok) {
      const g = selection.grammar;
      context = contexts.get(g.version);
      if (!context) { context = { ...base, parser: new CommandParser(loadGrammarTree(g), { textFormat: g.textFormat }) }; contexts.set(g.version, context); }
    }
    const verdict = staticCommandCoverage(row.cmd, row.source, context);
    inc(`${row.source}.${verdict.status}`);
    functions.push({ ...(row.function === undefined ? {} : { function: row.function }), status: verdict.status });
    if (verdict.status === "macro" || !context) continue;
    const parsed = context.parser.parse(row.cmd);
    if (!parsed.ok) continue;
    for (const node of parsed.nodes) {
      if (node.kind === "literal" && ["predicate", "advancement", "loot"].includes(node.name)) inc(`usage.literal.${node.name}`);
      if (node.value?.kind === "selector") for (const arg of node.value.selector.arguments) {
        if (arg.key === "advancements" || arg.key === "predicate") inc(`usage.selector.${arg.key}`);
        if (arg.key === "nbt" && arg.value.kind === "nbt") {
          inc("selector.nbt.arguments");
          for (const p of new Set(compoundPaths(arg.value.value))) path("selector", p);
        }
      }
    }
    const ir = toCommandIR(row.cmd, parsed.nodes);
    if (ir.command?.name !== "data") continue;
    const nodes = ir.command.nodes;
    inc("data.commands");
    // Each explicit source/target path counts once. Last entity/block/storage literal determines its owner.
    let owner = "unknown";
    for (const node of nodes) {
      if (node.kind === "literal" && ["entity", "block", "storage"].includes(node.name)) owner = node.name;
      if (node.value?.kind === "nbtPath") path(`data.${owner}`, publicPath(node.value.path, owner === "storage"));
      if (node.value?.kind === "nbt" && nodes.some(n => n.kind === "literal" && n.name === "merge")) {
        for (const p of new Set(compoundPaths(node.value.value, owner === "storage"))) path(`merge.${owner}`, p);
      }
    }
  }
  console.log(JSON.stringify({ counts, functions: functionSummary(functions), paths: [...paths].sort((a,b) => b[1]-a[1]) }, null, 2));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.argv[2]) throw new Error("usage: node tools/survey-corpus.ts <private-commands.jsonl>");
  main(process.argv[2]);
}
