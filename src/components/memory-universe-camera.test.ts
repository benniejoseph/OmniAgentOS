import { describe, expect, it } from "vitest";
import { universeSphereFitDistance } from "@/components/memory-universe-camera";

describe("Universe perspective framing", () => {
  it.each([2.5, 1, 0.55, 0.2])("keeps a depth-bearing sphere inside both axes at aspect %s", (aspect) => {
    const radius = 31;
    const verticalFov = 46;
    const distance = universeSphereFitDistance(radius, verticalFov, aspect);
    const verticalTangent = Math.tan(verticalFov * Math.PI / 360);
    const horizontalTangent = verticalTangent * aspect;
    let maxProjectedX = 0;
    let maxProjectedY = 0;
    for (let latitude = 0; latitude <= 32; latitude += 1) {
      const phi = latitude / 32 * Math.PI;
      for (let longitude = 0; longitude < 64; longitude += 1) {
        const theta = longitude / 64 * Math.PI * 2;
        const x = radius * Math.sin(phi) * Math.cos(theta);
        const y = radius * Math.sin(phi) * Math.sin(theta);
        const z = radius * Math.cos(phi);
        // Camera-space z changes the projected size of near and far points.
        maxProjectedX = Math.max(maxProjectedX, Math.abs(x / ((distance - z) * horizontalTangent)));
        maxProjectedY = Math.max(maxProjectedY, Math.abs(y / ((distance - z) * verticalTangent)));
      }
    }
    expect(distance).toBeGreaterThan(radius);
    expect(maxProjectedX).toBeLessThan(0.9);
    expect(maxProjectedY).toBeLessThan(0.9);
  });

  it("continues moving back as narrow canvases reduce the horizontal field of view", () => {
    const wide = universeSphereFitDistance(20, 46, 2.5);
    const phone = universeSphereFitDistance(20, 46, 0.55);
    const narrow = universeSphereFitDistance(20, 46, 0.2);
    expect(phone).toBeGreaterThan(wide);
    expect(narrow).toBeGreaterThan(phone * 2);
  });
});
