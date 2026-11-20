import { ItemStack, system, world } from "@minecraft/server";

function hopperContainers(y: number) {
  const dim = world.getDimension("overworld");
  return Array.from({ length: 100 }, (_, i) =>
    dim.getBlock({ x: Math.floor(i / 10), y, z: i % 10 })!.getComponent("inventory")!.container!);
}

function scores(count: number): number[] {
  const values = new Map(world.scoreboard.getObjective("density")!.getScores()
    .map(({ participant, score }) => [participant.displayName, score]));
  return Array.from({ length: count }, (_, id) => values.get(`b${id}`) ?? 0);
}

system.afterEvents.scriptEventReceive.subscribe(({ id, message }) => {
  if (id === "je2be:density-stock") {
    const { y } = JSON.parse(message) as { y: number };
    for (const container of hopperContainers(y)) container.setItem(0, new ItemStack("minecraft:stone", 64));
    console.log("DENSITY_STOCKED");
  }
  if (id !== "je2be:density-sample") return;
  const { chunks, ticks, hopperY } = JSON.parse(message) as { chunks: number[]; ticks: number; hopperY?: number };
  const count = chunks.reduce((sum, n) => sum + n, 0);
  const hopperItems = (y: number): number[] => hopperContainers(y).map((c) => c.getItem(0)?.amount ?? 0);
  // 同じ runInterval フェーズ同士を引き、最初の読み取りを基準にする。
  let previous: number[] | undefined;
  let start = 0;
  const updatesByChunk = chunks.map((): number[] => []);
  const perBlock = Array<number>(count).fill(0);
  let hopperStart: number[] | undefined;
  let largestDelta = 0;
  let smallestDelta = 1;
  const handle = system.runInterval(() => {
    const current = scores(count);
    if (previous) {
      let id = 0;
      for (const [chunk, size] of chunks.entries()) {
        let total = 0;
        const end = id + size;
        for (; id < end; id++) {
          const delta = current[id]! - previous[id]!;
          perBlock[id] = perBlock[id]! + delta;
          largestDelta = Math.max(largestDelta, delta);
          smallestDelta = Math.min(smallestDelta, delta);
          total += delta;
        }
        updatesByChunk[chunk]!.push(total);
      }
    } else {
      start = system.currentTick;
      if (hopperY !== undefined) hopperStart = hopperItems(hopperY);
    }
    previous = current;
    if (updatesByChunk[0]!.length === ticks) {
      system.clearRun(handle);
      console.log("DENSITY_SERIES " + JSON.stringify({ start, end: system.currentTick, updatesByChunk, largestDelta, smallestDelta }));
      // BDSのログ1行の長さを抑える。
      for (let offset = 0; offset < count; offset += 100) {
        console.log("DENSITY_BLOCKS " + JSON.stringify({ offset, deltas: perBlock.slice(offset, offset + 100) }));
      }
      if (hopperY !== undefined) {
        console.log("DENSITY_HOPPERS " + JSON.stringify({ before: hopperStart, after: hopperItems(hopperY) }));
      }
      const { commandBlocksEnabled, functionCommandLimit, maxCommandChainLength, randomTickSpeed } = world.gameRules;
      console.log("DENSITY_RULES " + JSON.stringify({ commandBlocksEnabled, functionCommandLimit, maxCommandChainLength, randomTickSpeed }));
      console.log("DENSITY_DONE");
    }
  }, 1);
});
