import { isDeepStrictEqual } from "node:util";
import { CommandParser, commandGrammarCandidates, rewriteCommand, selectCommandGrammar, type PackFormatRange, type RewriteContext } from "@je2be/core";
import { loadGrammarTree, type JavaGrammarInstallation } from "@je2be/converter";

export type CorpusVersion = { dataVersion: number | null; packFormat?: number | null; packFormatRange?: PackFormatRange | null };
export function corpusContext(row: CorpusVersion, command: string, grammars: JavaGrammarInstallation[], base: RewriteContext, contexts: Map<string, RewriteContext>): { context?: RewriteContext; different: boolean } {
  const source = { ...(row.dataVersion == null ? {} : { dataVersion: row.dataVersion }),
    ...(row.packFormat == null ? {} : { packFormat: row.packFormat }),
    ...(row.packFormatRange == null ? {} : { packFormatRange: row.packFormatRange }) };
  const selected = selectCommandGrammar(grammars, source);
  const candidates = selected.ok ? [selected.grammar] : selected.reason === "ambiguous" ? commandGrammarCandidates(grammars, source) : [];
  const versions = candidates.map(g => {
    let context = contexts.get(g.version);
    if (!context) { context = { ...base, parser: new CommandParser(loadGrammarTree(g), { textFormat: g.textFormat }) }; contexts.set(g.version, context); }
    return context;
  });
  const first = versions[0];
  if (!first) return { different: false };
  const parsed = first.parser.parse(command);
  const rewrite = parsed.ok ? rewriteCommand(command, first) : undefined;
  if (versions.slice(1).some(v => {
    const other = v.parser.parse(command);
    return !isDeepStrictEqual(parsed, other) || (other.ok && !isDeepStrictEqual(rewrite, rewriteCommand(command, v)));
  })) return { different: true };
  return { context: first, different: false };
}
