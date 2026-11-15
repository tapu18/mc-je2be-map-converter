// tick内の実行順のPoC。各実行元が `je2be:mark <名前>`（同期実行されるカスタムコマンド）か
// スクリプトから mark() を呼び、通し番号付きで `POC <JSON>` をコンソールに出す。
// 記録は計測開始の合図（scriptevent je2be:start）から一定tick数だけ行う。
import { CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus, system } from "@minecraft/server";

let recording = false;
let seq = 0;

function mark(source: string): void {
  if (!recording) return;
  console.log("POC " + JSON.stringify({ tick: system.currentTick, seq: ++seq, source }));
}

system.beforeEvents.startup.subscribe((ev) => {
  ev.customCommandRegistry.registerCommand(
    {
      name: "je2be:mark",
      description: "実行順の記録",
      permissionLevel: CommandPermissionLevel.GameDirectors,
      mandatoryParameters: [{ name: "source", type: CustomCommandParamType.String }],
    },
    (_origin, source: string) => {
      mark(source);
      system.run(() => mark(`${source}.system_run`));
      return { status: CustomCommandStatus.Success };
    },
  );
});

system.runInterval(() => {
  mark("runInterval");
  system.run(() => mark("runInterval.system_run"));
}, 1);

system.afterEvents.scriptEventReceive.subscribe((ev) => {
  if (ev.id === "je2be:start") {
    recording = true;
    const ticks = Number(ev.message) || 20;
    system.runTimeout(() => {
      recording = false;
      console.log("POC_DONE");
    }, ticks);
    return;
  }
  if (ev.id === "je2be:mark") mark(`scriptevent:${ev.message}`);
});

system.run(() => console.log("POC_READY"));
