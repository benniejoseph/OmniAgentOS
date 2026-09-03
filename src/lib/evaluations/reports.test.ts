import { describe, expect, it } from "vitest";
import { reportDownloadFilename } from "@/lib/evaluations/reports";
import type { EvalReportSnapshot } from "@/lib/evaluations/types";

describe("evaluation report downloads", () => {
  it("uses the Asael filename for signed report snapshots", () => {
    const report = {
      id: "report-123",
      evalRunId: "run-456",
    } as EvalReportSnapshot;

    expect(reportDownloadFilename(report)).toBe(
      "asael-eval-run-456-report-123.json",
    );
  });
});
