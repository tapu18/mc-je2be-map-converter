// BDSの検証用パック。
// ブリッジがサーバーコンソールから `scriptevent je2be:req <JSON>` を送り、
// このパックが処理して `JE2BE_RES <JSON>` をコンソールに出力する。
import { EffectTypes, system, world, type Dimension, type Vector3 } from "@minecraft/server";

interface Request {
  id: number;
  op: string;
  [key: string]: unknown;
}

type Handler = (req: Request) => unknown;

const PREFIX = "JE2BE_RES ";
// コンソール1行の長さに上限があり得るため、長い応答は分割して送る
const CHUNK = 3000;

function reply(id: number, body: { ok: true; result: unknown } | { ok: false; error: string }): void {
  const text = JSON.stringify({ id, ...body });
  if (text.length <= CHUNK) {
    console.log(PREFIX + text);
    return;
  }
  const total = Math.ceil(text.length / CHUNK);
  for (let i = 0; i < total; i++) {
    console.log(`JE2BE_PART ${id} ${i} ${total} ${text.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  }
}

function dim(req: Request): Dimension {
  return world.getDimension(typeof req.dimension === "string" ? req.dimension : "overworld");
}

function vec(v: unknown): Vector3 {
  const a = v as number[];
  return { x: a[0]!, y: a[1]!, z: a[2]! };
}

const handlers: Record<string, Handler> = {
  ping: () => ({ tick: system.currentTick }),

  cmd: (req) => {
    const r = dim(req).runCommand(String(req.cmd));
    return { successCount: r.successCount };
  },

  scores: () =>
    world.scoreboard.getObjectives().map((o) => ({
      objective: o.id,
      scores: o.getScores().map((s) => ({
        participant: s.participant.displayName,
        type: s.participant.type,
        score: s.score,
      })),
    })),

  blocks: (req) => {
    const from = vec(req.from);
    const to = vec(req.to ?? req.from);
    const d = dim(req);
    const out: { pos: number[]; type: string | null; states?: Record<string, unknown> }[] = [];
    for (let x = Math.min(from.x, to.x); x <= Math.max(from.x, to.x); x++)
      for (let y = Math.min(from.y, to.y); y <= Math.max(from.y, to.y); y++)
        for (let z = Math.min(from.z, to.z); z <= Math.max(from.z, to.z); z++) {
          const b = d.getBlock({ x, y, z });
          out.push(b ? { pos: [x, y, z], type: b.typeId, states: b.permutation.getAllStates() } : { pos: [x, y, z], type: null });
        }
    return out;
  },

  effectTypes: () => EffectTypes.getAll().map((type) => type.getName()).sort(),

  blockWaterlogged: (req) => dim(req).getBlock(vec(req.pos))?.isWaterlogged,

  entityEffects: (req) => {
    const probes = req.probes as Record<string, Record<string, string>>;
    const dimension = dim(req);
    return Object.fromEntries(Object.entries(probes).map(([tag, ids]) => {
      const entities = dimension.getEntities({ tags: [tag] });
      if (entities.length !== 1) throw new Error(`Expected one entity tagged ${tag}, got ${entities.length}`);
      return [tag, Object.fromEntries(Object.entries(ids).map(([key, id]) => {
        const type = EffectTypes.get(id);
        const effect = type && entities[0]!.getEffect(type);
        return [key, effect ? { amplifier: effect.amplifier, duration: effect.duration } : null];
      }))];
    }));
  },

  entities: (req) => {
    const opts = (req.query ?? {}) as Parameters<Dimension["getEntities"]>[0];
    const objectives = (req.scoreObjectives as string[] | undefined) ?? [];
    return dim(req)
      .getEntities(opts)
      .map((e) => ({
        id: e.id,
        type: e.typeId,
        pos: [e.location.x, e.location.y, e.location.z],
        rot: [e.getRotation().x, e.getRotation().y],
        tags: e.getTags(),
        nameTag: e.nameTag,
        ...(req.components ? {
          markVariant: e.getComponent("minecraft:mark_variant")?.value,
          scale: e.getComponent("minecraft:scale")?.value,
          health: e.getComponent("minecraft:health")?.currentValue,
          invisible: e.getEffect("invisibility") !== undefined,
          components: e.getComponents().map((c) => c.typeId),
        } : {}),
        ...(objectives.length ? { scores: Object.fromEntries(objectives.flatMap((id) => {
          const identity = e.scoreboardIdentity;
          const score = identity && world.scoreboard.getObjective(id)?.getScore(identity);
          return score === undefined ? [] : [[id, score]];
        })) } : {}),
      }));
  },

  /** チャンクが読み込まれるまで待つための確認用 */
  loaded: (req) => {
    try {
      return dim(req).getBlock(vec(req.pos)) !== undefined;
    } catch {
      return false;
    }
  },
};

system.afterEvents.scriptEventReceive.subscribe((ev) => {
  if (ev.id !== "je2be:req") return;
  let req: Request;
  try {
    req = JSON.parse(ev.message) as Request;
  } catch (e) {
    console.log(PREFIX + JSON.stringify({ id: -1, ok: false, error: `bad request: ${String(e)}` }));
    return;
  }
  const h = handlers[req.op];
  if (!h) return reply(req.id, { ok: false, error: `unknown op: ${req.op}` });
  try {
    reply(req.id, { ok: true, result: h(req) });
  } catch (e) {
    reply(req.id, { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
  }
});

system.run(() => console.log("JE2BE_READY"));
