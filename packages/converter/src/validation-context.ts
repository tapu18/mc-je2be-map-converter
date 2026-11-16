// 保存された有効順を保ち、無効・未選択のパックを検証へ混ぜない。
import { lstatSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { child, type NbtTag } from "@je2be/core";
import { readGzipNbt } from "./java-world.ts";

export interface JavaValidationContext {
  world: string;
  dataVersion?: number | undefined;
  enabled: string[];
  disabled: string[];
  /** enabled の file/ パックと同じ順。 */
  datapacks: string[];
  /** file/ 以外のパック。有効順の再構成に使う。 */
  packOrder: ({ builtin: string } | { datapack: number })[];
}

export function readJavaValidationContext(world: string): JavaValidationContext {
  const directory = resolve(world);
  const data = child(readGzipNbt(join(directory, "level.dat")), "Data");
  const packs = child(data, "DataPacks");
  function strings(tag: NbtTag | undefined, name: string): string[] {
    if (tag?.type !== "list" || tag.value.some((v) => v.type !== "string")) throw new Error(`missing or invalid DataPacks.${name}`);
    return tag.value.flatMap((v) => v.type === "string" ? [v.value] : []);
  }
  const enabled = strings(child(packs, "Enabled"), "Enabled");
  const disabled = strings(child(packs, "Disabled"), "Disabled");
  if (new Set(enabled).size !== enabled.length || enabled.some((id) => disabled.includes(id))) throw new Error("inconsistent DataPacks enabled/disabled lists");
  const version = child(data, "DataVersion");
  const datapacks: string[] = [];
  const packOrder = enabled.map((id) => {
    if (!id.startsWith("file/")) return { builtin: id };
    const name = id.slice(5);
    if (!name || name === "." || name === ".." || /[\\/]/.test(name)) throw new Error(`invalid world datapack ID: ${id}`);
    const path = join(directory, "datapacks", name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`invalid world datapack: ${id}`);
    if (!realpathSync(path).startsWith(realpathSync(join(directory, "datapacks")) + sep)) throw new Error(`world datapack escapes directory: ${id}`);
    datapacks.push(path);
    return { datapack: datapacks.length - 1 };
  });
  return { world: directory, dataVersion: version?.type === "int" ? version.value : undefined, enabled, disabled, datapacks, packOrder };
}
