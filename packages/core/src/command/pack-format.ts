/** Pack format is ordered by major and then minor. */
export type PackVersion = readonly [major: number, minor: number];
export interface PackFormatRange { min: PackVersion; max: PackVersion }

function version(value: unknown): PackVersion | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return [value, 0];
  if (Array.isArray(value) && value.length === 2 && value.every(v => Number.isSafeInteger(v) && v >= 0)) return [value[0], value[1]];
  return undefined;
}
export function comparePackVersions(a: PackVersion, b: PackVersion): number {
  return a[0] - b[0] || a[1] - b[1];
}
/** Read the effective range from the pack section of a pack.mcmeta object. */
export function readPackFormatRange(metadata: unknown): PackFormatRange | undefined {
  if (!metadata || typeof metadata !== "object" || !("pack" in metadata)) return undefined;
  const pack = metadata.pack;
  if (!pack || typeof pack !== "object") return undefined;
  const p = pack as Record<string, unknown>;
  let min: PackVersion | undefined, max: PackVersion | undefined;
  if ("min_format" in p || "max_format" in p) {
    min = version(p.min_format); max = version(p.max_format);
  } else if ("supported_formats" in p) {
    const supported = p.supported_formats;
    if (Array.isArray(supported) && supported.length === 2) {
      min = version(supported[0]); max = version(supported[1]);
    } else if (supported && typeof supported === "object") {
      const obj = supported as Record<string, unknown>;
      min = version(obj.min_inclusive); max = version(obj.max_inclusive);
    } else {
      min = max = version(supported);
    }
  } else {
    min = max = version(p.pack_format);
  }
  return min && max && comparePackVersions(min, max) <= 0 ? { min, max } : undefined;
}
