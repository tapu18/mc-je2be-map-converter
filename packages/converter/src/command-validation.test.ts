import { describe, expect, it } from "vitest";
import { buildJavaValidationReport, classifyJavaValidationError, javaValidationSkipReason, type JavaCheckBatch } from "./command-validation.ts";

const error = "Can't find element 'test:missing' in registry 'minecraft:predicate' at position 33";

describe("Java validation report", () => {
  it("separates unresolved references, invalid values/IDs, and unchecked macros", () => {
    const commands = ["say x", "execute if predicate test:missing", "attribute @s minecraft:generic.max_health base set 20", "give @s stone[custom_model_data=1]", "$say $(v)"]
      .map((command, i) => ({ id: `block:${i}`, command }));
    const batch: JavaCheckBatch = { checked: true, enabledPacks: "vanilla", contextErrors: [], results: [
      { command: commands[0]!.command, ok: true },
      { command: commands[1]!.command, ok: false, error },
      { command: commands[2]!.command, ok: false, error: "Can't find element 'minecraft:generic.max_health' of type 'minecraft:attribute'" },
      { command: commands[3]!.command, ok: false, error: "Malformed 'minecraft:custom_model_data' component: 'Not a map: 1'" },
    ] };
    const report = buildJavaValidationReport(commands, batch, { javaVersion: "26.3", datapacks: ["pack"] });
    expect(report.summary).toEqual({ total: 5, valid: 1, invalid: 2, unresolvedReferences: 1, notChecked: 1, contextErrors: 0 });
    expect(report.diagnostics.map((d) => d.code)).toEqual(["java-unresolved-reference", "java-invalid-id", "java-invalid-value", "java-not-checked"]);
    expect(report.diagnostics[0]).toMatchObject({ id: "block:1", severity: "warning", message: error });
    expect(report.complete).toBe(false);
    expect(report.javaVersion).toBe("26.3");
  });

  it("does not label commands invalid when the pack context cannot load", () => {
    const report = buildJavaValidationReport([{ id: "fn:1", command: "say x" }], {
      checked: false, results: [], contextErrors: ["Failed to load datapacks"], enabledPacks: "",
    }, { javaVersion: "26.3" });
    expect(report.results).toEqual([{ id: "fn:1", status: "not-checked" }]);
    expect(report.summary).toMatchObject({ invalid: 0, notChecked: 1, contextErrors: 1 });
    expect(report.complete).toBe(false);
    expect(report.diagnostics.at(-1)?.code).toBe("java-context-error");
  });

  it("rejects mismatched verdicts and duplicate input IDs", () => {
    const batch = { checked: true, results: [], contextErrors: [], enabledPacks: "" };
    const commands = [{ id: "a", command: "say x" }];
    expect(() => buildJavaValidationReport(commands, batch, { javaVersion: "26.3" })).toThrow(/do not match/);
    expect(() => buildJavaValidationReport([...commands, ...commands], batch, { javaVersion: "26.3" })).toThrow(/duplicate/);
  });

  it("keeps comments, multiline input and continuation lines out of checked counts", () => {
    for (const command of ["", " # comment", "say x\nsay y", "say x\\"]) expect(javaValidationSkipReason(command)).toBeDefined();
    expect(javaValidationSkipReason("say x")).toBeUndefined();
    expect(classifyJavaValidationError("Unknown block tag 'test:tag'")).toBe("java-unresolved-reference");
    expect(classifyJavaValidationError("new Java error wording")).toBe("java-invalid-command");
  });
});
