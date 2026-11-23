import { expect, it } from "vitest";
import { readNbtPath } from "../command/arguments.ts";
import { StringReader } from "../command/reader.ts";
import { parseSnbt } from "../command/snbt.ts";
import { getNbtPath } from "./nbt-path.ts";
import { removeNbtPath, setNbtPath } from "./nbt-mutation.ts";

const path = (s: string) => readNbtPath(new StringReader(s));
it("creates compound paths and copies inserted values", () => {
  const root = parseSnbt('{}');
  const value = parseSnbt('{x:1}');
  expect(setNbtPath(root, path('a.b'), value)).toBe(1);
  expect(getNbtPath(root, path('a.b'))).toEqual([value]);
  expect(getNbtPath(root, path('a.b'))[0]).not.toBe(value);
});
it("removes all filtered list elements without shifting later matches", () => {
  const root = parseSnbt('{list:[{id:1},{id:2},{id:1}]}');
  expect(removeNbtPath(root, path('list[{id:1}]'))).toBe(2);
  expect(root).toEqual(parseSnbt('{list:[{id:2}]}'));
});
