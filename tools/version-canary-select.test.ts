import { expect, it } from "vitest";
import { selectBedrockBeta } from "./version-canary-select.ts";

it("selects a beta matching the BDS stable series, not a newer preview or another series", () => {
  const versions = ["2.9.0-beta.1.26.66-stable", "2.10.0-beta.1.26.66-stable", "2.11.0-beta.1.26.70-preview.1", "2.12.0-beta.1.26.70-stable"];
  expect(selectBedrockBeta(versions, "1.26.66.1", versions[2]!)).toBe(versions[1]);
  expect(selectBedrockBeta(versions, "1.26.66.1", versions[0]!)).toBe(versions[0]);
  expect(() => selectBedrockBeta(versions, "1.26.67.1", versions[2]!)).toThrow("no beta package");
});
