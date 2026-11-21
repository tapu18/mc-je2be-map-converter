// 変換シナリオ（scenarios/convert/）を、人がボタンで操作できる検証用マップに作り替える（#86）。
//
// - play の「インパルスのコマンドブロックの隣に redstone_block を置く」起動は、同じ位置のボタンにする
// - それ以外の play のコマンド（防具立ての召喚など）は、準備用のコマンドブロックのチェーンとボタンにまとめる。
//   目的変数を作るシナリオでは、準備でサイドバーに表示する（観測には影響しない）
// - 自動の検査では、押された状態のボタンを setblock で置いて押下を再現する（両版で隣のコマンドブロックが動くことを実測。docs/findings.md）
import type { MappingTables } from "@je2be/core";
import type { BedrockBlockMapper } from "./scenario/normalize.ts";
import { javaBlockString } from "./scenario/normalize.ts";
import type { Action, Facing, Scenario, ScenarioCommandBlock, Vec3 } from "./scenario/types.ts";

export interface PlaytestButton {
  /** 人に伝える名前 */
  label: string;
  pos: Vec3;
  /** ボタンの向き（付いているブロックから離れる向き） */
  facing: Facing;
}

export interface PlaytestStep {
  button: PlaytestButton;
  /** 押した後に待つ tick */
  ticks: number;
}

export interface Playtest {
  id: string;
  /** 変換前の Java ワールドに置くもの。元の setup と actions に、準備のチェーンとボタンを足したもの */
  setup: string[];
  actions: Action[];
  /** 押す順 */
  steps: PlaytestStep[];
  /** 押した後の観測（元のシナリオと同じ。正解データとも比べる） */
  observe: Scenario["observe"];
  requiredObservations: string[];
  /** 押す前に見るボタンの位置。変換後もボタンが同じ向きで残っていることを確かめる */
  buttonObserve: Scenario["observe"];
}

const OFFSETS: Record<Facing, Vec3> = { down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };
const BE_FACING: Record<Facing, number> = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 };
const TRIGGER = /^setblock (-?\d+) (-?\d+) (-?\d+) minecraft:redstone_block$/;
const OBJECTIVE = /^scoreboard objectives add (\S+) /;
/** 準備のチェーンを置く列。BDS の読み込み範囲（0..63）に入れる。シナリオの配置と重なれば失敗にする */
const PREP_X = 0;

const same = (a: Vec3, b: Vec3): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

export function javaButton(b: PlaytestButton, pressed: boolean): string {
  const face = b.facing === "up" ? "floor" : b.facing === "down" ? "ceiling" : "wall";
  // 床・天井のボタンの facing は回転なので北に固定する
  const facing = face === "wall" ? b.facing : "north";
  return `minecraft:stone_button[face=${face},facing=${facing},powered=${pressed}]`;
}

export function bedrockButton(b: PlaytestButton, pressed: boolean): string {
  return `stone_button ["facing_direction"=${BE_FACING[b.facing]},"button_pressed_bit"=${pressed}]`;
}

function commandBlocks(actions: Action[]): ScenarioCommandBlock[] {
  return actions.flatMap((a) => ("commandBlocks" in a ? a.commandBlocks : []));
}

/** 起動の位置に隣り合うインパルスのコマンドブロックから、ボタンの向きを決める */
function triggerButton(pos: Vec3, blocks: ScenarioCommandBlock[], label: string): PlaytestButton | undefined {
  for (const facing of Object.keys(OFFSETS) as Facing[]) {
    const attached = add(pos, OFFSETS[facing].map((v) => -v) as Vec3);
    if (blocks.some((b) => b.kind === "impulse" && b.alwaysActive === false && same(b.pos, attached))) return { label, pos, facing };
  }
  return undefined;
}

export function toPlaytest(s: Scenario): Playtest {
  if (!s.id || !s.play) throw new Error(`${s.id ?? "?"}: 変換シナリオ（play あり）だけを作り替えられる`);
  const blocks = commandBlocks(s.actions);
  const prepCommands: string[] = [];
  const triggers: PlaytestButton[] = [];
  for (const a of s.play) {
    if (!("run" in a)) {
      if ("commandBlocks" in a) throw new Error(`${s.id}: play でコマンドブロックを置く操作は作り替えられない`);
      continue;
    }
    const m = TRIGGER.exec(a.run);
    const button = m ? triggerButton([Number(m[1]), Number(m[2]), Number(m[3])], blocks, `実行${triggers.length + 1}`) : undefined;
    if (button) triggers.push(button);
    else {
      if (triggers.length) throw new Error(`${s.id}: 起動の後に準備のコマンドがある（${a.run}）`);
      prepCommands.push(a.run);
    }
  }
  if (!triggers.length) throw new Error(`${s.id}: ボタンにできる起動がない`);
  for (const c of s.setup) {
    const m = OBJECTIVE.exec(c);
    if (m) prepCommands.push(`scoreboard objectives setdisplay sidebar ${m[1]}`);
  }
  const extra: Action[] = [];
  const buttons: PlaytestButton[] = [...triggers];
  if (prepCommands.length) {
    const y = blocks[0]?.pos[1] ?? -60;
    const prep: ScenarioCommandBlock[] = prepCommands.map((command, i) => ({
      pos: [PREP_X, y, 2 + i], kind: i === 0 ? "impulse" : "chain", facing: "south", alwaysActive: i === 0 ? false : true, command,
    }));
    const used = [...blocks.map((b) => b.pos), ...triggers.map((b) => b.pos)];
    const taken = [...prep.map((b) => b.pos), [PREP_X, y, 1] as Vec3].find((p) => used.some((u) => same(u, p)));
    if (taken) throw new Error(`${s.id}: 準備のチェーンがシナリオの配置と重なる（${taken.join(" ")}）`);
    extra.push({ commandBlocks: prep });
    buttons.unshift({ label: "準備", pos: [PREP_X, y, 1], facing: "north" });
  }
  for (const b of buttons) extra.push({ run: `setblock ${b.pos.join(" ")} ${javaButton(b, false)}` });
  const steps: PlaytestStep[] = buttons.map((button) => ({ button, ticks: 5 }));
  if (!s.requiredObservations?.length) throw new Error(`${s.id}: requiredObservations がない`);
  return {
    id: s.id, setup: s.setup, actions: [...s.actions, ...extra], steps,
    observe: s.observe, requiredObservations: s.requiredObservations, buttonObserve: { blocks: buttons.map((b) => ({ from: b.pos })) },
  };
}

/**
 * BE のブロックの状態を、ID 対応表（Geyser）で Java の書き方に戻す。
 * BE の1つの状態に Java の状態が1つだけ対応するときだけ戻し、それ以外は undefined（比較不能）にする。
 * 変換器（Chunker）は別の対応表を使うため、この対応表での比較は変換の結果の確認になる
 */
export function geyserBlockMapper(tables: Pick<MappingTables, "blocks">): BedrockBlockMapper {
  const byBedrock = new Map<string, MappingTables["blocks"]>();
  for (const row of tables.blocks) byBedrock.set(row.bedrock.id, [...(byBedrock.get(row.bedrock.id) ?? []), row]);
  return (type, states) => {
    const rows = (byBedrock.get(type) ?? []).filter((r) => Object.entries(r.bedrock.states).every(([k, v]) => states[k] === v));
    const javas = new Set(rows.map((r) => javaBlockString(r.java.id, r.java.states)));
    return javas.size === 1 ? [...javas][0] : undefined;
  };
}
