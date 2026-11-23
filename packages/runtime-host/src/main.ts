import { world } from "@minecraft/server";
import { initialize } from "./initialize.js";
import { objectives, entities } from "./data.js";

world.afterEvents.worldLoad.subscribe(() => {
  initialize(objectives, entities).catch((error: unknown) => console.warn("[je2be] initialization failed: " + error));
});
