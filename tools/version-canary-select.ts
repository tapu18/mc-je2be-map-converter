/** BDS の安定版系列と一致する npm beta だけを候補にする。 */
export function selectBedrockBeta(versions: readonly string[], bedrock: string, tagged: string): string {
  const series = bedrock.split(".").slice(0, 3).join(".");
  const matches = versions.filter((v) => /^\d+\.\d+\.\d+-beta\.\d+\.\d+\.\d+-stable$/.test(v) && v.endsWith(`-beta.${series}-stable`));
  if (matches.includes(tagged)) return tagged;
  matches.sort((a, b) => {
    const left = a.split("-", 1)[0]!.split(".").map(Number);
    const right = b.split("-", 1)[0]!.split(".").map(Number);
    return left[0]! - right[0]! || left[1]! - right[1]! || left[2]! - right[2]!;
  });
  const selected = matches.at(-1);
  if (!selected) throw new Error(`no beta package matching BDS ${series}`);
  return selected;
}
