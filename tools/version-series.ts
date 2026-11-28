// Geyser 対応表の版と、検証・出力に使う固定版（tools/servers.json）の系列を突き合わせる（#362）。
// 系列の規則の根拠は docs/workflow.md の「Geyser 対応表の版上げ」。

/** BE の安定版 1.A.BC.D は、1.A.B0 が機能版、1 の位と4番目が修正版。例：1.26.66.1 → 1.26.60。 */
export function bedrockSeries(version: string): string {
  const match = /^1\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(version);
  if (!match) throw new Error(`unexpected Bedrock version: ${version}`);
  return `1.${match[1]}.${Math.floor(Number(match[2]) / 10) * 10}`;
}

/** JE の年番号の版 YY.N[.P] は YY.N が機能版、P が修正版。旧来の 1.X.Y は 3 つ目まで別の版として扱う。 */
export function javaSeries(version: string): string {
  const year = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version);
  if (!year) throw new Error(`unexpected Java version: ${version}`);
  if (year[1] !== "1") return `${year[1]}.${year[2]}`;
  const legacy = /^1\.(\d+)(?:\.(\d+))?$/.exec(version);
  if (!legacy) throw new Error(`unexpected Java version: ${version}`);
  return `1.${legacy[1]}.${legacy[2] ?? "0"}`;
}

export type GeyserVersions = { readonly javaVersion: string; readonly bedrockVersion: string };
export type ServerVersions = { readonly java: { readonly version: string }; readonly bedrock: { readonly version: string } };

/** 系列のずれを返す。空なら一致。 */
export function geyserSeriesMismatches(geyser: GeyserVersions, servers: ServerVersions): string[] {
  const problems: string[] = [];
  if (javaSeries(geyser.javaVersion) !== javaSeries(servers.java.version)) {
    problems.push(`Java: Geyser mappings are for ${geyser.javaVersion} (series ${javaSeries(geyser.javaVersion)}), tools/servers.json pins ${servers.java.version} (series ${javaSeries(servers.java.version)})`);
  }
  if (bedrockSeries(geyser.bedrockVersion) !== bedrockSeries(servers.bedrock.version)) {
    problems.push(`Bedrock: Geyser mappings are for ${geyser.bedrockVersion} (series ${bedrockSeries(geyser.bedrockVersion)}), tools/servers.json pins ${servers.bedrock.version} (series ${bedrockSeries(servers.bedrock.version)})`);
  }
  return problems;
}
