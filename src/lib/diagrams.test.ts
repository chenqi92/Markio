import { describe, expect, it } from "vitest";
import { normalizePlantUmlServer, plantUmlEncode } from "./diagrams";

describe("diagram helpers", () => {
  it("encodes PlantUML source with the PlantUML URL alphabet", () => {
    const encoded = plantUmlEncode("@startuml\nA -> B\n@enduml");
    expect(encoded).toMatch(/^[0-9A-Za-z_-]+$/);
    expect(encoded.length).toBeGreaterThan(8);
  });

  it("normalizes PlantUML server URLs", () => {
    expect(normalizePlantUmlServer("https://example.test/plantuml/")).toBe(
      "https://example.test/plantuml",
    );
    expect(() => normalizePlantUmlServer("file:///tmp/plantuml")).toThrow(
      /http\/https/,
    );
  });
});
