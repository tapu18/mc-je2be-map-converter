import { expect, it } from "vitest";
import { parseSnbt } from "../command/snbt.ts";
import { readNbtPath } from "../command/arguments.ts";
import { StringReader } from "../command/reader.ts";
import { getNbtPath } from "./nbt-path.ts";

it("resolves negative indices and compound filters in list order", () => {
  const root = parseSnbt('{list:[{id:1,v:10},{id:2,v:20},{id:1,v:30}]}');
  const path = (s: string) => readNbtPath(new StringReader(s));
  expect(getNbtPath(root, path('list[{id:1}].v'))).toEqual([parseSnbt('10'), parseSnbt('30')]);
  expect(getNbtPath(root, path('list[-1].v'))).toEqual([parseSnbt('30')]);
  expect(getNbtPath(root, path('list[9]'))).toEqual([]);
});
