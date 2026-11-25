// 実機テスト（*.servers.test.ts）を CI の並列ジョブに割り当てる。
// 使い方: node tools/server-test-groups.ts <グループ名>   → そのグループのテストファイルを空白区切りで出す
//         node tools/server-test-groups.ts --list        → グループ名と割り当てを表示する
//
// どのグループにも当てはまらないテストは "misc" に入る。新しいテストが割り当て漏れで実行されないことはない。
// CI の動的な matrix は tools/server-test-plan.ts で作る。
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** グループ名 → 対象のパス（先頭一致）。所要時間（CI、2026-11-15）がおおむね揃うように分ける */
export const GROUPS: Record<string, string[]> = {
  // 正解データのシナリオ。CI ではこのファイルだけシナリオ ID で分割する。
  scenarios: ["packages/bridge/src/scenario/scenarios.servers.test.ts"],
  grammar: ["packages/bridge/src/versioned-grammar"],
  bridge: ["packages/"],
  "poc-a": ["poc/tick-order/", "poc/launcher/dimension", "poc/coordinates/"],
  performance: ["poc/repeat-performance/"],
  // 上のどれにも当てはまらないもの
  misc: [],
};

function findTests(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return findTests(p);
    return name.endsWith(".servers.test.ts") ? [relative(root, p)] : [];
  });
}

export function assign(): Record<string, string[]> {
  const tests = [...findTests(join(root, "packages")), ...findTests(join(root, "poc"))].sort();
  const out: Record<string, string[]> = Object.fromEntries(Object.keys(GROUPS).map((g) => [g, []]));
  for (const t of tests) {
    const group = Object.entries(GROUPS).find(([, prefixes]) => prefixes.some((p) => t.startsWith(p)))?.[0] ?? "misc";
    out[group]!.push(t);
  }
  return out;
}

if (import.meta.main) {
  const arg = process.argv[2];
  if (arg === "--list") {
    for (const [group, files] of Object.entries(assign())) console.log(`${group}:\n${files.map((file) => `  ${file}`).join("\n")}`);
  } else if (arg && Object.hasOwn(GROUPS, arg)) {
    console.log(assign()[arg]!.join(" "));
  } else {
    console.error(`usage: node tools/server-test-groups.ts <${Object.keys(GROUPS).join("|")}|--list>`);
    process.exit(2);
  }
}
