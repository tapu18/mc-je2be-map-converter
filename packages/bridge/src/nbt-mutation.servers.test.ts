import { expect, it } from "vitest";
import { JavaServer } from "./java.ts";

it("reports unchanged storage values and creates a list before an absent index", async () => {
  const java = await JavaServer.start();
  try {
    expect(await java.exec("data modify storage test:paths a set value 1")).toMatch(/Modified storage/);
    expect(await java.exec("data modify storage test:paths a set value 1")).toMatch(/Nothing changed/);
    expect(await java.exec("data modify storage test:paths missing.list[0].x set value 2")).toMatch(/Found no elements/);
    expect(await java.exec("data get storage test:paths missing.list")).toMatch(/\[\]/);
  } finally {
    await java.stop();
  }
});

it("inserts at negative indices relative to the end of a storage list", async () => {
  const java = await JavaServer.start();
  try {
    await java.exec("data modify storage test:paths list set value [1,2]");
    expect(await java.exec("data modify storage test:paths list insert -1 value 3")).toMatch(/Modified storage/);
    expect(await java.exec("data get storage test:paths list")).toMatch(/\[1, 2, 3\]/);
  } finally {
    await java.stop();
  }
});

it("merges storage compounds recursively and reports unchanged merges", async () => {
  const java = await JavaServer.start();
  try {
    await java.exec("data merge storage test:paths {a:{x:1,y:2}}");
    expect(await java.exec("data merge storage test:paths {a:{x:3}}")).toMatch(/Modified storage/);
    expect(await java.exec("data get storage test:paths a")).toMatch(/x: 3/);
    expect(await java.exec("data get storage test:paths a")).toMatch(/y: 2/);
    expect(await java.exec("data merge storage test:paths {a:{x:3}}")).toMatch(/Nothing changed/);
  } finally { await java.stop(); }
});

it("creates missing list and compound targets for storage modifications", async () => {
  const java = await JavaServer.start();
  try {
    expect(await java.exec("data modify storage test:paths a.list append value 3")).toMatch(/Modified storage/);
    expect(await java.exec("data modify storage test:paths a.object merge value {x:1}")).toMatch(/Modified storage/);
    expect(await java.exec("data get storage test:paths a")).toMatch(/list: \[3\]/);
    expect(await java.exec("data get storage test:paths a")).toMatch(/object: \{x: 1\}/);
  } finally { await java.stop(); }
});

it("takes a substring from a storage string using negative end indices", async () => {
  const java = await JavaServer.start();
  try {
    await java.exec('data modify storage test:paths source set value "abcdef"');
    expect(await java.exec('data modify storage test:paths dest set string storage test:paths source 1 -1')).toMatch(/Modified storage/);
    expect(await java.exec('data get storage test:paths dest')).toMatch(/bcde/);
  } finally { await java.stop(); }
});
