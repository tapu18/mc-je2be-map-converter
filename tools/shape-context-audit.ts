// Recheck the failed #112 probes without executing their commands.
import { readFileSync, writeFileSync } from "node:fs";
import { inspectJavaSyntax } from "@je2be/bridge";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: node tools/shape-context-audit.ts AUDIT.json OUTPUT.json");
const audit = JSON.parse(readFileSync(input, "utf8")) as { results: { id: string; command: string; java: { ok: boolean } }[] };
const probes = audit.results.filter(r => !r.java.ok && /^(test |time |gamerule )/.test(r.command)).map(r => ({
  id: r.id,
  original: r.command,
  command: r.command.replace("minecraft:probe", "minecraft:always_pass").replace(/query minecraft:overworld/g, "query minecraft:day"),
}));
const inspection = await inspectJavaSyntax(probes.map(p => p.command), { packOrder: [{ builtin: "vanilla" }, { builtin: "minecart_improvements" }] });
if (!inspection.checked || inspection.contextErrors.length) throw new Error(`Invalid context: ${inspection.contextErrors.join("; ")}`);
writeFileSync(output, JSON.stringify({ probes, inspection }, null, 2) + "\n");
