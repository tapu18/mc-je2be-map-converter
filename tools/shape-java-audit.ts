// Audit generated shape probes against Java without running any generated commands.
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { textFormatFor, rewriteCommand } from "@je2be/core";
import { loadRewriteContext } from "@je2be/converter";
import { checkJavaSyntax } from "@je2be/bridge";
import { executableShapes, shapeProbes, terminalShape } from "./compatibility-inventory.ts";

const output = process.argv[2];
if (!output) throw new Error("Usage: node tools/shape-java-audit.ts OUTPUT.json");
const versions = JSON.parse(readFileSync("tools/servers.json", "utf8")) as { java: { version: string; dataVersion: number } };
const reports = join("servers", `reports-${versions.java.version}`, "reports");
const context = loadRewriteContext({ commandsJson: join(reports, "commands.json"), blocksJson: join(reports, "blocks.json"), mappingsJson: "servers/mappings/mappings.json" }, textFormatFor(versions.java.dataVersion));
const shapes = [...executableShapes(context.parser.root)].map(([id, path]) => ({ id, ...shapeProbes(path) }));
const probes = shapes.flatMap(({ id, commands }) => commands.map(command => ({ id, command })));
const java = await checkJavaSyntax(probes.map(p => p.command));
const results = probes.map((probe, i) => {
  const parsed = context.parser.parse(probe.command);
  const rewrite = rewriteCommand(probe.command, context);
  return { ...probe, java: java[i], parser: parsed.ok, terminal: parsed.ok ? terminalShape(context.parser.root, parsed.nodes) : null, rewrite };
});
writeFileSync(output, JSON.stringify({ javaVersion: versions.java.version, shapes, results }, null, 2) + "\n");
