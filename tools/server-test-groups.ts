// 実機テスト（*.servers.test.ts）を CI の並列ジョブに割り当てる。
// 使い方: node tools/server-test-groups.ts <グループ名>   → そのグループのテストファイルを空白区切りで出す
//         node tools/server-test-groups.ts --list        → グループ名と割り当てを表示する
//
// どのグループにも当てはまらないテストは "misc" に入る。新しいテストが割り当て漏れで実行されないことはない。
// グループを増やしたら .github/workflows/ci.yml の matrix にも足すこと（--check で確かめられる）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** グループ名 → 対象のパス（先頭一致）。所要時間（CI、2026-11-15）がおおむね揃うように分ける */
export const GROUPS: Record<string, string[]> = {
  // 約47秒
  bridge: ["packages/"],
  // 約73秒
  "poc-a": ["poc/tick-order/", "poc/launcher/dimension", "poc/coordinates/"],
  // 約136秒。PR では関連する変更があるときだけ流す（ci.yml）
  performance: ["poc/repeat-performance/"],
  // 上のどれにも当てはまらないもの（約46秒：terrain-converter、launcher、dynamic-properties、mcstructure-version など）
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

const arg = process.argv[2];
if (arg === "--list") {
  for (const [g, files] of Object.entries(assign())) console.log(`${g}:\n${files.map((f) => `  ${f}`).join("\n")}`);
} else if (arg === "--check") {
  // ci.yml の matrix とグループ名が一致しているか
  const yml = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const missing = Object.keys(GROUPS).filter((g) => !new RegExp(`group: ${g}\\b`).test(yml));
  const empty = Object.entries(assign()).filter(([, f]) => f.length === 0).map(([g]) => g);
  if (missing.length) {
    console.error(`ci.yml の matrix にないグループ: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log(`ok（テストのないグループ: ${empty.join(", ") || "なし"}）`);
} else if (arg && arg in GROUPS) {
  console.log(assign()[arg]!.join(" "));
} else {
  console.error(`usage: node tools/server-test-groups.ts <${Object.keys(GROUPS).join("|")}|--list|--check>`);
  process.exit(2);
}
