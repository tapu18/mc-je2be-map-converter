// #15: JE comparator facing points toward its input. Verify both orientations.
import { expect, it } from "vitest";
import { JavaServer } from "./index.ts";

it("identifies the input side of saved JE comparator states", async () => {
  const java = await JavaServer.start();
  try {
    // Stay inside the forceloaded area, with enough supporting floor.
    await java.exec("fill 19 -50 19 35 -50 23 stone");
    await java.exec("setblock 21 -49 20 comparator[facing=east]");
    await java.exec("setblock 31 -49 20 comparator[facing=west]");
    // Place input after comparator, so a neighbor update schedules its evaluation.
    await java.exec("setblock 20 -49 20 redstone_block");
    await java.exec("setblock 30 -49 20 redstone_block");
    const deadline = Date.now() + 5000;
    while (!/Test passed/.test(await java.exec("execute if block 31 -49 20 comparator[powered=true]"))) {
      if (Date.now() >= deadline) throw new Error("comparator did not evaluate input");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(await java.exec("data get block 31 -49 20 OutputSignal")).toMatch(/: 15$/);
    expect(await java.exec("data get block 21 -49 20 OutputSignal")).toMatch(/: 0$/);
    expect(await java.exec("execute if block 21 -49 20 comparator[powered=false]")).toMatch(/Test passed/);
  } finally {
    await java.stop();
  }
});
