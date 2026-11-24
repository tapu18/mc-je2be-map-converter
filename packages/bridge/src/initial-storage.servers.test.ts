import { expect, it } from "vitest";
import { collectInitialStorage, JavaWorld } from "@je2be/converter";
import { deserializeStorage, nbtToPlain } from "@je2be/core";
import { JavaServer } from "./index.ts";

it("encodes saved Java storage matching the Java server dump", async () => {
  const java = await JavaServer.start();
  try {
    await java.exec('data merge storage test:one {n:9223372036854775807L,a:[L;-9223372036854775808L,9007199254740993L],nested:{b:1b}}');
    await java.exec('data merge storage other:two {text:"hello",list:[1,2]}');
    const dump = await java.dump({storage: true});
    const result = collectInitialStorage(new JavaWorld(java.worldDirectory));
    expect(result.storageErrors).toEqual([]);
    expect(Object.fromEntries(result.storageEntries.map(e => [e.id, nbtToPlain(deserializeStorage(e.chunks.join("")))]))).toEqual(dump.storage);
  } finally { await java.stop(); }
});
