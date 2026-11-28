import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GEYSER_SOURCE } from "../packages/converter/src/geyser-source.ts";
import { bedrockSeries, geyserSeriesMismatches, javaSeries } from "./version-series.ts";

const servers = JSON.parse(readFileSync(new URL("./servers.json", import.meta.url), "utf8"));

describe("Geyser mapping version series (#362)", () => {
  it("matches the pinned Java server and BDS", () => {
    // 失敗したら docs/workflow.md の「Geyser 対応表の版上げ」に従う。
    expect(geyserSeriesMismatches(GEYSER_SOURCE, servers)).toEqual([]);
  });

  it("fails when BDS moves to the next feature release without new mappings", () => {
    const drifted = { ...servers, bedrock: { ...servers.bedrock, version: "1.26.70.1" } };
    expect(geyserSeriesMismatches(GEYSER_SOURCE, drifted)).toEqual([expect.stringMatching(/^Bedrock: .*1\.26\.70\.1 \(series 1\.26\.70\)/)]);
  });

  it("fails when the Java server moves to the next release without new mappings", () => {
    const drifted = { ...servers, java: { ...servers.java, version: "26.4" } };
    expect(geyserSeriesMismatches(GEYSER_SOURCE, drifted)).toEqual([expect.stringMatching(/^Java: .*26\.4 \(series 26\.4\)/)]);
  });

  it("treats hotfixes as the same series", () => {
    expect(bedrockSeries("1.26.60")).toBe("1.26.60");
    expect(bedrockSeries("1.26.66.1")).toBe("1.26.60");
    expect(bedrockSeries("1.21.111.1")).toBe("1.21.110");
    expect(bedrockSeries("1.26.3")).toBe("1.26.0");
    expect(javaSeries("26.1.2")).toBe("26.1");
    expect(javaSeries("26.3")).toBe("26.3");
    expect(javaSeries("1.21")).toBe("1.21.0");
    expect(javaSeries("1.21.4")).not.toBe(javaSeries("1.21.5"));
    expect(() => bedrockSeries("26.60")).toThrow("unexpected Bedrock version");
  });
});
