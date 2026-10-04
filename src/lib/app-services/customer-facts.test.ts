import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), submit: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/memory/shared-context", async (original) => ({ ...(await original<typeof import("@/lib/memory/shared-context")>()), requestSharedMemoryAccessFromSecurityContext: mocks.access }));
vi.mock("@/lib/customer-success/fact-native-store", () => ({ submitCustomerFactNativeMutation: mocks.submit, readCustomerFactNativeAcceptance: mocks.read }));
import { recordCustomerFactNativeService, readCustomerFactNativeAcceptanceService } from "@/lib/app-services/customer-facts";
import { factAccess, factActorId, factCaller, factFixture } from "@/lib/customer-success/fact-mutation.test-fixtures";
import { nativeCustomerFactMutationResponseSchema, nativeCustomerFactAcceptanceReadResponseSchema } from "@/lib/mobile/customer-fact-mutation-contracts";
const f = factFixture();
beforeEach(() => { vi.clearAllMocks(); mocks.access.mockResolvedValue(factAccess()); mocks.submit.mockResolvedValue(f.committed);
  mocks.read.mockResolvedValue({ currentAccount: f.currentAccount, acceptance: f.acceptance }); });
describe("native manual fact service boundary", () => {
  it("binds canonical-only mutation authority and validates the exact service outcome receipt", async () => {
    const result = await recordCustomerFactNativeService(factCaller(true), { ...f.request, accountId: f.accountId });
    expect(mocks.submit.mock.calls[0][0].authority).toMatchObject({ canonicalActorId: factActorId, readableActorIds: [factActorId],
      executionScope: { purpose: "customer.account.fact.record", causationId: f.accountId, workspaceId: f.workspaceId } });
    expect(nativeCustomerFactMutationResponseSchema.safeParse({ ...result.data, serviceReceipt: result.receipt }).success).toBe(true);
    mocks.submit.mockResolvedValue({ ...f.committed, acceptance: { ...f.acceptance, requestSha256: "f".repeat(64) } });
    await expect(recordCustomerFactNativeService(factCaller(true), { ...f.request, accountId: f.accountId })).rejects.toThrow();
  });
  it("allows current reader receipt recovery and keeps a missing receipt null", async () => {
    mocks.access.mockResolvedValue(factAccess(false));
    const input = { accountId: f.accountId, workspaceId: f.workspaceId, keySha256: f.intent.idempotencyKeySha256 };
    const result = await readCustomerFactNativeAcceptanceService(factCaller(), input);
    expect(nativeCustomerFactAcceptanceReadResponseSchema.safeParse({ ...result.data, serviceReceipt: result.receipt }).success).toBe(true);
    expect(result.data.context.canWrite).toBe(false);
    mocks.read.mockResolvedValue({ currentAccount: f.currentAccount, acceptance: null });
    expect((await readCustomerFactNativeAcceptanceService(factCaller(), input)).data.acceptance).toBeNull();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("rejects a delegated caller, wrong workspace and a viewer mutation before the store", async () => {
    const caller = factCaller(true);
    await expect(recordCustomerFactNativeService({ ...caller, executionScope: { ...caller.executionScope!, delegationId: "delegation:other" } },
      { ...f.request, accountId: f.accountId })).rejects.toThrow();
    await expect(recordCustomerFactNativeService(caller, { ...f.request, workspaceId: "workspace:other", accountId: f.accountId })).rejects.toThrow();
    mocks.access.mockResolvedValue(factAccess(false));
    await expect(recordCustomerFactNativeService(caller, { ...f.request, accountId: f.accountId })).rejects.toThrow();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});
