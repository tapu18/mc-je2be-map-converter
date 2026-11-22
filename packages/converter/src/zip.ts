import AdmZip from "adm-zip";
import { zipSync } from "fflate";
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";

// Limits apply to the entire archive, including function bodies that are replaced by stubs.
export const ZIP_MAX_FILES = 10_000;
export const ZIP_MAX_BYTES = 256 * 1024 * 1024;

export function extractDatapackZip(source: string, destination: string): void {
  if (statSync(source).size > ZIP_MAX_BYTES) throw new Error("ZIP compressed size limit exceeded");
  const archive = new AdmZip(source);
  const entries = archive.getEntries();
  if (entries.length > ZIP_MAX_FILES) throw new Error("ZIP file count limit exceeded");
  let total = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = entry.entryName;
    const parts = name.replace(/\/$/, "").split("/");
    const mode = entry.header.attr >>> 16;
    const type = mode & 0o170000;
    if (!name || name.startsWith("/") || name.includes("\\") || parts.some(p => !p || p === "." || p === "..") || parts[0]!.includes(":") || (type !== 0 && type !== 0o100000 && type !== 0o040000) || (type === 0o040000 && !entry.isDirectory) || (type === 0o100000 && entry.isDirectory)) throw new Error(`unsafe ZIP entry: ${name}`);
    const normalized = parts.join("/");
    if (seen.has(normalized)) throw new Error(`duplicate ZIP entry: ${name}`);
    seen.add(normalized);
    total += entry.header.size;
    if (total > ZIP_MAX_BYTES) throw new Error("ZIP expanded size limit exceeded");
    if ((entry.header.flags & 1) || ![0, 8].includes(entry.header.method)) throw new Error("unsupported ZIP entry");
  }
  mkdirSync(destination); // exclusive: never alter an existing destination
  try {
    for (const entry of entries) {
      const target = join(destination, ...entry.entryName.replace(/\/$/, "").split("/"));
      if (entry.isDirectory) { mkdirSync(target, { recursive: true }); continue; }
      const compressed = entry.getCompressedData();
      const data = entry.header.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.header.size + 1) });
      if (data.length !== entry.header.size || crc32(data) !== entry.header.crc) throw new Error("invalid ZIP entry size or checksum");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.entryName.endsWith(".mcfunction") ? "# je2be: validation-only function placeholder\n" : data, { flag: "wx" });
    }
  } catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
}

export function writeWorldZip(world: string, output: string): void {
  const files: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), rel = prefix + name, stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`symlink in world: ${path}`);
      if (stat.isDirectory()) walk(path, rel + "/");
      else if (stat.isFile()) files[rel] = readFileSync(path);
      else throw new Error(`unsupported world entry: ${path}`);
    }
  };
  walk(world, "");
  writeFileSync(output, zipSync(files), { flag: "wx" });
}
