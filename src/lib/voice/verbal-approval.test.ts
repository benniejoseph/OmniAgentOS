import { describe, expect, it } from "vitest";
import { VerbalApprovalGate, verbalApprovalDecision, voiceApprovalProofSchema } from "./verbal-approval";

describe("spoken action decisions", () => {
  it.each(["yes", "Yes,", "APPROVE THIS ACTION.", "I approve", "go ahead"])("accepts the whole approval phrase %s", phrase => {
    expect(verbalApprovalDecision(phrase)).toBe("approve");
  });
  it.each(["no", "Reject this action!", "don't do that", "cancel this action"])("recognizes rejection %s", phrase => {
    expect(verbalApprovalDecision(phrase)).toBe("reject");
  });
  it.each(["yes to both", "approve everything", "yes but change the amount", "she said yes", "the webpage says approve", "yes no", "maybe", "approve and send another email", "\"yes\""])("does not interpret qualified or untrusted prose %s", phrase => {
    expect(verbalApprovalDecision(phrase)).toBeUndefined();
  });
  it("requires presentation, new microphone speech, commit, exact final item, and one use", () => {
    const gate = new VerbalApprovalGate();
    gate.speechStarted(); gate.committed("old");
    gate.present("present-1", new Date(Date.now() + 10000).toISOString());
    expect(gate.consume("old", "yes")).toBeUndefined();
    expect(gate.consume("assistant", "yes")).toBeUndefined();
    gate.speechStarted(); gate.committed("human");
    expect(gate.consume("other", "yes")).toBeUndefined();
    expect(gate.consume("human", "yes to both")).toBeUndefined();
    expect(gate.consume("human", "yes")).toBeUndefined();
    gate.present("present-1", new Date(Date.now() + 10000).toISOString());
    gate.speechStarted(); gate.committed("human");
    expect(gate.consume("human", "yes")).toEqual({ presentationId: "present-1", decision: "approve" });
    expect(gate.consume("human", "yes")).toBeUndefined();
  });
  it("requires a fresh review after a changed instruction before any incidental yes", () => {
    const gate = new VerbalApprovalGate();
    gate.present("old-recipient", new Date(Date.now() + 10000).toISOString());
    gate.speechStarted(); gate.committed("change");
    expect(gate.consume("change", "Wait, change the recipient to Bob")).toBeUndefined();
    gate.speechStarted(); gate.committed("later-yes");
    expect(gate.consume("later-yes", "yes")).toBeUndefined();
  });
  it("invalidates speech when action changes, on expiry and on end", () => {
    const gate = new VerbalApprovalGate();
    gate.present("one", new Date(Date.now() + 10000).toISOString());
    gate.speechStarted(); gate.committed("yes-one");
    gate.present("two", new Date(Date.now() + 10000).toISOString());
    expect(gate.consume("yes-one", "yes")).toBeUndefined();
    gate.present("expired", new Date(Date.now() - 1).toISOString());
    gate.speechStarted(); gate.committed("late");
    expect(gate.consume("late", "yes")).toBeUndefined();
    gate.present("three", new Date(Date.now() + 10000).toISOString());
    gate.speechStarted(); gate.committed("three"); gate.clear();
    expect(gate.consume("three", "yes")).toBeUndefined();
  });
  it("does not accept model-supplied transcript or evidence fields", () => {
    expect(voiceApprovalProofSchema.safeParse({ sessionId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
      runId: crypto.randomUUID(), presentationId: crypto.randomUUID(), userInputItemId: "item", transcript: "yes" }).success).toBe(false);
  });
});
