import { expect, it } from "vitest";
import { readNbtPath } from "../command/arguments.ts";
import { StringReader } from "../command/reader.ts";
import { parseSnbt } from "../command/snbt.ts";
import { getNbtPath } from "./nbt-path.ts";
import { insertNbtPath, removeNbtPath, setNbtPath } from "./nbt-mutation.ts";

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
it("counts only changed values and creates intermediate lists before a missing index", () => {
  const root = parseSnbt('{a:1,list:[{id:1},{id:1}]}');
  expect(setNbtPath(root, path('a'), parseSnbt('1'))).toBe(0);
  expect(setNbtPath(root, path('list[{id:1}].id'), parseSnbt('1'))).toBe(0);
  expect(setNbtPath(root, path('list[{id:1}].id'), parseSnbt('2'))).toBe(2);
  expect(setNbtPath(root, path('missing.list[0].x'), parseSnbt('2'))).toBe(0);
  expect(getNbtPath(root, path('missing.list'))).toEqual([parseSnbt('[]')]);
  expect(setNbtPath(root, path('empty'), parseSnbt('{}'))).toBe(1);
});
it("inserts copies into lists at positive and negative positions", () => {
  const root = parseSnbt('{list:[{id:1},{id:2}]}');
  const value = parseSnbt('{id:3}');
  expect(insertNbtPath(root, path('list'), 1, [value])).toBe(1);
  expect(insertNbtPath(root, path('list'), -1, [parseSnbt('{id:4}')])).toBe(1);
  expect(root).toEqual(parseSnbt('{list:[{id:1},{id:3},{id:2},{id:4}]}'));
  expect(getNbtPath(root, path('list[1]'))[0]).not.toBe(value);
  expect(insertNbtPath(root, path('list'), 9, [value])).toBe(0);
});
