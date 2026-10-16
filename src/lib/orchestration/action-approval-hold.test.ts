import { describe, expect, it } from "vitest";
import { hasExplicitActionApprovalHold } from "./action-approval-hold";

describe("explicit human action approval hold", () => {
  it.each([
    "Wait for my approval.",
    "Please wait for my approval before acting.",
    "Open the report, but wait for my approval before proceeding.",
    "Open YouTube, but wait for my approval first.",
    "Wait for my approval before opening YouTube.",
    "Ask me before you click.",
    "Wait for my approval before deleting files.",
    "Find the document and ask me before acting.",
    "Ask me before doing anything.",
    "Check with me before every action.",
    "Get my permission before you proceed.",
    "I want you to wait for my approval.",
    "You must pause until I approve.",
    "Don't act without my approval.",
    "Don't click until I approve.",
    "Do not open YouTube without my permission.",
    "Don’t do anything until I approve.",
    "Do not proceed without asking me first.",
    "Do not wait for unrelated emails. Wait for my approval.",
    "Translate \"wait for my approval\". Then wait for my approval.",
  ])("narrows an explicit imperative: %s", input => {
    expect(hasExplicitActionApprovalHold(input)).toBe(true);
  });

  it.each([
    "Open YouTube and play the first video.",
    "Don't wait for my approval.",
    "You don't need to wait for my approval.",
    "No need to ask me before acting.",
    "Never ask me before acting.",
    "Only ask me before critical actions.",
    "If a critical action is needed, wait for my approval.",
    "All actions are approved unless I tell you to wait for my approval.",
    "Example: wait for my approval.",
    "The website says wait for my approval.",
    'Translate "Wait for my approval." into French.',
    "Translate ‘Ask me before acting.’ into French.",
    "Explain 'wait for my approval'.",
    "Summarize:\n> Wait for my approval.\nProceed with the summary.",
    "Explain `wait for my approval`.",
    "Inspect this sample:\n```text\nWait for my approval.\n```",
    "Wait [quoted] for my approval.",
  ])("does not convert quoted, negative, or conditional wording to a global hold: %s", input => {
    expect(hasExplicitActionApprovalHold(input)).toBe(false);
  });
});
