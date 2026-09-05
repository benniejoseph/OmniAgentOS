import { describe, expect, it, vi } from "vitest";
import {
  CaptureIngestInvalidatedError,
  assertCaptureIngestSource,
  lockActiveCaptureIngest,
  type CaptureIngestGuard,
} from "@/lib/capture/ingest-guard";

const assetGuard: CaptureIngestGuard = {
  kind: "asset",
  captureId: "asset-a",
  tenantId: "tenant-a",
  actorId: "owner-a",
  ingestJobId: "job-a",
};

describe("capture ingest deletion guard", () => {
  it("locks the exact active asset/job ownership tuple", async () => {
    const sql = vi.fn(async (
      _strings: TemplateStringsArray,
      ..._params: unknown[]
    ) => [{ id: "asset-a" }]);

    await expect(lockActiveCaptureIngest(sql, assetGuard)).resolves.toBeUndefined();

    const statement = sql.mock.calls[0]?.[0] as TemplateStringsArray;
    expect(statement.join("?")).toContain("FROM omni_capture_assets");
    expect(statement.join("?")).toContain("FOR UPDATE");
    expect(sql.mock.calls[0]?.slice(1)).toEqual([
      "tenant-a",
      "owner-a",
      "asset-a",
      "job-a",
    ]);
  });

  it("fails closed after the capture row or job binding disappears", async () => {
    const sql = vi.fn(async (
      _strings: TemplateStringsArray,
      ..._params: unknown[]
    ) => []);

    await expect(lockActiveCaptureIngest(sql, {
      ...assetGuard,
      kind: "recording",
      captureId: "recording-a",
    })).rejects.toBeInstanceOf(CaptureIngestInvalidatedError);
    const statement = sql.mock.calls[0]?.[0] as TemplateStringsArray;
    expect(statement.join("?")).toContain("FROM omni_capture_recordings");
  });

  it("rejects a guard reused for another tenant or source", () => {
    expect(() => assertCaptureIngestSource(
      assetGuard,
      "tenant-b",
      "capture:asset:asset-a",
    )).toThrow(CaptureIngestInvalidatedError);
    expect(() => assertCaptureIngestSource(
      assetGuard,
      "tenant-a",
      "capture:asset:asset-b",
    )).toThrow(CaptureIngestInvalidatedError);
  });
});
