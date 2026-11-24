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
