// #205: in a fresh world, an absent entity prevents execution of the parsed command.
import { readFileSync, writeFileSync } from "node:fs";
import { JavaServer } from "@je2be/bridge";

const doc = readFileSync("docs/command-shape-audit.md", "utf8");
const candidates = [...doc.matchAll(/^\| .*? \| `([^`]+)` \| 未確定 \|$/gm)].map(m => m[1]!);
if (candidates.length !== 53) throw new Error(`expected 53 candidates, found ${candidates.length}`);
const boundaries = [
  "scoreboard players set x y 2147483647", "scoreboard players set x y 2147483648", "scoreboard players set x y -2147483649",
  "tick rate 0", "tick rate 1", "tick rate 10000", "tick rate 10001", "tick rate 1e2", "tick rate 1.0",
  "transfer probe 0", "transfer probe 65536", "transfer probe 1 @s", "transfer probe 65535 @s",
  'datapack create probe {"text":"probe"}', "datapack create probe invalid", 'say "unterminated',
  "execute positioned ~ ~ ~ run say ok",
];
const java = await JavaServer.start();
try {
  const probe = (command: string) => java.exec(`execute if entity @e[tag=je2be_absent] run ${command}`);
  if (await probe("stop") !== "" || !(await probe("stop garbage")).includes("Incorrect argument") || !(await java.exec("list")).includes("players online")) {
    throw new Error("parse-only controls failed");
  }
  const results: { command: string; response: string }[] = [];
  for (const command of [...candidates, ...boundaries]) results.push({ command, response: await probe(command) });
  writeFileSync("/tmp/audit205.json", JSON.stringify(results, null, 2) + "\n");
} finally { await java.stop(); }
