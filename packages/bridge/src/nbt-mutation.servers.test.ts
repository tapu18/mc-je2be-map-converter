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
