// Load synthetic rewritten commands as functions; never invoke the functions.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BedrockServer } from "@je2be/bridge";

type Entry = { id: string; command: string; java: { ok: boolean }; rewrite: { status: string; command?: string } };
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: node tools/shape-bedrock-audit.ts JAVA.json OUTPUT.json");
const audit = JSON.parse(readFileSync(input, "utf8")) as { shapes: { id: string }[]; results: Entry[] };
const eligible = audit.results.filter(r => r.java.ok && (r.rewrite.status === "rewritten" || r.rewrite.status === "unchanged") && r.rewrite.command !== undefined);
const pack = mkdtempSync(join(tmpdir(), "je2be-bds-syntax-"));
let bds: BedrockServer | undefined;
try {
  mkdirSync(join(pack, "functions"));
  writeFileSync(join(pack, "manifest.json"), JSON.stringify({ format_version: 2, header: { name: "syntax audit", description: "synthetic probes", uuid: "1e853cc2-7235-4c25-8a93-8238d9a23eee", version: [1, 0, 0], min_engine_version: [1, 21, 0] }, modules: [{ type: "data", uuid: "0b94e76a-b500-4ba2-8a19-99e89051aabc", version: [1, 0, 0] }] }));
  const controls = ["time set noon", "time set bogus", "effect @a je2be_invalid", "je2be_invalid_command", "scoreboard objectives add JE2BE_LOAD_MARKER dummy"];
  const commands = [...controls, ...eligible.map(r => r.rewrite.command!)];
  commands.forEach((command, i) => {
    if (/[\r\n]/.test(command)) throw new Error("Multiline command");
    writeFileSync(join(pack, "functions", `c${i}.mcfunction`), command + "\n");
  });
  bds = await BedrockServer.start({ behaviorPacks: [pack], tickingArea: false });
  const failures = new Set<number>();
  for (const line of bds.log) {
    const match = /Function c(\d+) failed to load correctly/.exec(line);
    if (match) failures.add(Number(match[1]));
  }
  if (failures.has(0) || ![1, 2, 3].every(i => failures.has(i)) || failures.has(4)) throw new Error(`Controls failed: ${[...failures]}`);
  // Absence of the marker proves that loading did not run this mutating control.
  const marker = await bds.exec("scoreboard objectives add JE2BE_LOAD_MARKER dummy");
  if (!marker.ok || marker.result?.successCount !== 1) throw new Error("Load marker already existed or could not be checked");
  const byShape = audit.shapes.map(shape => {
    const all = audit.results.filter(r => r.id === shape.id);
    const indexes = eligible.flatMap((r, i) => r.id === shape.id ? [i] : []);
    return { id: shape.id, candidates: all.length, eligible: indexes.length, accepted: indexes.filter(i => !failures.has(i + controls.length)).length, rejected: indexes.filter(i => failures.has(i + controls.length)).length, untested: all.length - indexes.length };
  });
  const results = eligible.map((r, i) => ({ ...r, bedrock: failures.has(i + controls.length) ? "rejected" : "no-load-error" }));
  writeFileSync(output, JSON.stringify({ byShape, results }, null, 2) + "\n");
  console.log(JSON.stringify({ shapes: byShape.length, eligible: eligible.length, rejected: results.filter(r => r.bedrock === "rejected").length, failures: [...failures] }));
} finally {
  await bds?.stop();
  rmSync(pack, { recursive: true, force: true });
}
