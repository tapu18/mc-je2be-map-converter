import type { ArgumentValue } from "../command/arguments.ts";
import type { ExecuteStep, ParsedNode } from "../command/parser.ts";
import {
  anchoredPosition, dimensionId, dimensionScale, entityTarget, facingRotation, inRange, resolvePosition, selectEntities,
  type ExecutionContext, type ExecutionHost, type Rotation, type RuntimeEntity,
} from "./context.ts";
import { blockPosition } from "./world.ts";
import { getNbtPath } from "./nbt-path.ts";
import { setNbtPath } from "./nbt-mutation.ts";
import type { Frame, Outcome, RuntimeState } from "./command.ts";
import type { ExecutionResult } from "./index.ts";

type Store = (outcome: ExecutionResult) => void;
export interface ExecuteBranch {
  context: ExecutionContext;
  stores: readonly Store[];
}

type StepResult = Iterable<ExecuteBranch> | Extract<ExecutionResult, {success: false}>;
type Modifier = (state: RuntimeState, branch: ExecuteBranch, depth: number, source: string) => Frame<StepResult>;
type Compile = (step: ExecuteStep, host?: ExecutionHost) => Modifier | undefined;
type Test = (state: RuntimeState, context: ExecutionContext, depth: number, source: string) => Frame<boolean | Extract<Outcome, {success: false}>>;

function condition(step: ExecuteStep, test: Test): Modifier {
  return function* (state, branch, depth, source) {
    yield {kind: "branch"};
    const matched = yield* test(state, branch.context, depth, source);
    if (typeof matched !== "boolean") return matched;
    return matched === (step.kind === "if") ? [branch] : {success: false, error: "condition failed"};
  };
}

function select(step: ExecuteStep, transform: (context: ExecutionContext, entity: RuntimeEntity) => ExecutionContext): Modifier | undefined {
  const target = entityTarget(step.nodes[0]?.value);
  if (!target) return;
  return function* (state, branch) {
    const entities = selectEntities(state.host, branch.context, target);
    if (!entities) return {success: false, error: "unsupported entity selection"};
    const branches: ExecuteBranch[] = [];
    for (const entity of entities) {
      yield {kind: "branch"};
      branches.push({...branch, context: transform(branch.context, entity)});
    }
    return branches;
  };
}

function coordinates(node: ParsedNode | undefined, count: number): node is ParsedNode & {value: Extract<ArgumentValue, {kind: "coordinates"}>} {
  return node?.value?.kind === "coordinates" && node.value.coordinates.length === count;
}

const comparisons = new Map<string, (left: number, right: number) => boolean>([
  ["=", (left, right) => left === right],
  ["<", (left, right) => left < right],
  ["<=", (left, right) => left <= right],
  [">", (left, right) => left > right],
  [">=", (left, right) => left >= right],
]);

const conditions = new Map<string, Compile>([
  ["data", step => {
    const [, kind, id, path] = step.nodes;
    if (kind?.name !== "storage" || id?.value?.kind !== "resource" || path?.value?.kind !== "nbtPath") return;
    const storageId = id.value.id, nbtPath = path.value.path;
    return condition(step, function* (state) {
      return getNbtPath(state.storage.get(storageId), nbtPath).length > 0;
    });
  }],
  ["score", step => {
    const [, holder, objective, operator, arg, otherObjective] = step.nodes;
    if (holder?.value?.kind !== "name" || objective?.value?.kind !== "word") return;
    const left = holder.value.value, leftObjective = objective.value.value;
    if (operator?.name === "matches" && arg?.value?.kind === "range") {
      const range = arg.value.range;
      return condition(step, function* (state) {
        const value = state.scores.get(left, leftObjective);
        return value !== undefined && inRange(value, range);
      });
    }
    const compare = comparisons.get(operator?.name ?? "");
    if (!compare || arg?.value?.kind !== "name" || otherObjective?.value?.kind !== "word") return;
    const right = arg.value.value, rightObjective = otherObjective.value.value;
    return condition(step, function* (state) {
      const lhs = state.scores.get(left, leftObjective), rhs = state.scores.get(right, rightObjective);
      return lhs !== undefined && rhs !== undefined && compare(lhs, rhs);
    });
  }],
  ["function", step => {
    const node = step.nodes[1], target = node?.value;
    if (!node || target?.kind !== "resource") return;
    return condition(step, function* (state, context, depth, source) {
      const names = target.tag ? state.functionTags.get(target.id) : [target.id];
      if (!names || names.some(name => !state.functions.has(name))) return {success: false, error: "unknown function"};
      for (const id of names) {
        const ir = {source, context: [], command: {name: "function", nodes: [{...node, value: {...target, id, tag: false}}]}};
        const result = yield {kind: "command", ir, depth, context};
        if (!result.success && result.error.startsWith("unsupported")) return result;
        if (result.success && result.explicitReturn === true && result.result !== 0) return true;
      }
      return false;
    });
  }],
  ["entity", (step, host) => {
    const target = entityTarget(step.nodes[1]?.value);
    if (!host || !target) return;
    return condition(step, function* (state, context) {
      const entities = selectEntities(state.host, context, target);
      return entities ? entities.length > 0 : {success: false, error: "unsupported entity selection"};
    });
  }],
  ["block", (step, host) => {
    const [, position, predicate] = step.nodes;
    const block = predicate?.value;
    if (!host || !coordinates(position, 3) || block?.kind !== "block" || block.tag || block.nbt) return;
    return condition(step, function* (state, context, _depth, source) {
      const actual = host.readBlock(context.dimension, blockPosition(position, source, context, state.host));
      return actual?.id === block.id && Object.entries(block.states).every(([key, value]) => actual.states[key] === value);
    });
  }],
  ["dimension", step => {
    const dimension = step.nodes[1]?.value;
    if (dimension?.kind !== "resource" || dimension.tag) return;
    return condition(step, function* (_state, context) {
      return context.dimension === dimensionId(dimension.id);
    });
  }],
]);

function storeValue(success: boolean, outcome: ExecutionResult): number {
  return outcome.success ? (success ? 1 : outcome.result) : 0;
}

const stores = new Map<string, Compile>([
  ["score", step => {
    const [mode, , holder, objective] = step.nodes;
    if (holder?.value?.kind !== "name" || objective?.value?.kind !== "word") return;
    const name = holder.value.value, key = objective.value.value;
    return function* (state, branch) {
      const store: Store = outcome => { state.scores.set(name, key, storeValue(mode?.name === "success", outcome)); };
      return [{...branch, stores: [...branch.stores, store]}];
    };
  }],
  ["storage", step => {
    const [mode, , id, path, type, scale] = step.nodes;
    if (id?.value?.kind !== "resource" || path?.value?.kind !== "nbtPath" || type?.name !== "int" || scale?.value?.kind !== "number") return;
    const storageId = id.value.id, nbtPath = path.value.path, multiplier = scale.value.value;
    return function* (state, branch) {
      const store: Store = outcome => {
        const n = Math.trunc(storeValue(mode?.name === "success", outcome) * multiplier);
        setNbtPath(state.storage.writable(storageId), nbtPath, {type: "int", value: Math.max(-2147483648, Math.min(2147483647, n))});
      };
      return [{...branch, stores: [...branch.stores, store]}];
    };
  }],
]);

const compileCondition: Compile = (step, host) => conditions.get(step.nodes[0]?.name ?? "")?.(step, host);

const modifiers = new Map<string, Compile>([
  ["if", compileCondition],
  ["unless", compileCondition],
  ["store", step => {
    const [mode, kind] = step.nodes;
    if (mode?.name === "result" || mode?.name === "success") return stores.get(kind?.name ?? "")?.(step);
  }],
  ["as", (step, host) => host && select(step, (context, entity) => ({...context, executor: entity.id}))],
  ["at", (step, host) => host && select(step, (context, entity) => ({
    ...context, position: entity.position, rotation: entity.rotation, dimension: dimensionId(entity.dimension),
  }))],
  ["positioned", step => {
    const node = step.nodes[0];
    if (!coordinates(node, 3)) return;
    return function* (state, branch, _depth, source) {
      const position = resolvePosition(node, source, branch.context, state.host);
      return [{...branch, context: {...branch.context, position, anchor: "feet"}}];
    };
  }],
  ["rotated", step => {
    const node = step.nodes[0];
    if (!coordinates(node, 2)) return;
    return function* (_state, branch) {
      const rotation = node.value.coordinates.map((coordinate, i) => coordinate.value + (coordinate.kind === "relative" ? branch.context.rotation[i]! : 0)) as Rotation;
      return [{...branch, context: {...branch.context, rotation}}];
    };
  }],
  ["facing", step => {
    const node = step.nodes[0];
    if (!coordinates(node, 3)) return;
    return function* (state, branch, _depth, source) {
      const context = branch.context;
      const rotation = facingRotation(anchoredPosition(context, state.host), resolvePosition(node, source, context, state.host));
      return [{...branch, context: {...context, rotation}}];
    };
  }],
  ["anchored", step => {
    const node = step.nodes[0]?.value;
    if (node?.kind !== "word" || (node.value !== "eyes" && node.value !== "feet")) return;
    const anchor = node.value;
    return function* (_state, branch) {
      return [{...branch, context: {...branch.context, anchor}}];
    };
  }],
  ["in", step => {
    const node = step.nodes[0]?.value;
    if (node?.kind !== "resource" || node.tag) return;
    const dimension = dimensionId(node.id);
    return function* (_state, branch) {
      const scale = dimensionScale(branch.context.dimension) / dimensionScale(dimension);
      const [x, y, z] = branch.context.position;
      return [{...branch, context: {...branch.context, dimension, position: [x * scale, y, z * scale]}}];
    };
  }],
]);

export function compileModifier(step: ExecuteStep, host?: ExecutionHost): Modifier | undefined {
  return modifiers.get(step.kind)?.(step, host);
}

export function applyStores(branch: ExecuteBranch, outcome: Outcome): void {
  for (let i = branch.stores.length - 1; i >= 0; i--) branch.stores[i]!(outcome);
}
