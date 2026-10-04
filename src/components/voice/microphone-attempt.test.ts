import { describe, expect, it, vi } from "vitest";
import { requestCurrentMicrophone } from "./microphone-attempt";
import { CommandWorkspaceScope } from "@/components/command/command-workspace-scope";

describe("reconnect microphone attempt", () => {
  it("stops a permission result from the prior account-access lifetime after the same owner returns", async () => {
    const scope = new CommandWorkspaceScope(true);
    const lease = scope.capture();
    const stop = vi.fn();
    let resolve!: (value: { getTracks(): Array<{ stop(): void }> }) => void;
    const pending = requestCurrentMicrophone(() => new Promise<{ getTracks(): Array<{ stop(): void }> }>((done) => { resolve = done; }), lease.current);
    scope.setAvailable(false);
    scope.setAvailable(true);
    resolve({ getTracks: () => [{ stop }] });
    expect(await pending).toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
    expect(scope.current()).toBe(true);
  });
  it("stops every late track after disposal without handing the stream to the connection", async () => {
    let resolve!: (stream: { getTracks(): Array<{ stop(): void }> }) => void;
    let current = true;
    const stops = [vi.fn(), vi.fn()];
    const pending = requestCurrentMicrophone(() => new Promise<{ getTracks(): Array<{ stop(): void }> }>((done) => { resolve = done; }), () => current);
    current = false;
    resolve({ getTracks: () => stops.map((stop) => ({ stop })) });
    expect(await pending).toBeUndefined();
    stops.forEach((stop) => expect(stop).toHaveBeenCalledOnce());
  });
  it("rejects an old attempt after a replacement starts and retains a current stream", async () => {
    let generation = 1;
    const token = generation;
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] };
    const old = requestCurrentMicrophone(async () => { generation += 1; return stream; }, () => generation === token);
    expect(await old).toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
    const currentStop = vi.fn();
    const live = { getTracks: () => [{ stop: currentStop }] };
    expect(await requestCurrentMicrophone(async () => live, () => true)).toBe(live);
    expect(currentStop).not.toHaveBeenCalled();
  });
});
