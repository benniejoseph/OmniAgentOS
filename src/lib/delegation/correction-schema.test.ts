import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { structuredCorrectionSchema } from "./correction-schema";
import { delegationResultJsonSchema } from "./runtime";

const criterion = "criterion:recorded-values";
const executionId = "idem_455c26411427314306cd32ae9b0229982e2257de5c3d4065d992bd8066947567";
const serviceHash = "3a453aaf321ae9492ec30de45ff4b0332fb01dc00d0d3d94782aad13c31fd46d";
const draft = () => ({ summary: "The saved project.objective describes a fictional Vendor B: USD 450, 10 days.",
  evidenceIds: [] as string[], toolExecutionIds: [executionId],
  acceptanceChecks: [{ criterionId: criterion, passed: true, note: "project.objective records the scenario values.", evidenceIds: [] as string[], toolExecutionIds: [executionId] }],
  draftArtifacts: [{ fileName: "vendor-b.md", mediaType: "text/markdown", content: "According to the saved fictional project objective, Vendor B costs USD 450 and takes 10 days." }],
});
const catalog = { citationIds: [] as string[], governedTools: [{ toolId: "app.projects.show", executionId }] };

describe("correction receipt contract", () => {
  it("accepts a bounded saved-text draft without requiring nonexistent citations or changing the immutable contract", () => {
    const contract = delegationResultJsonSchema([criterion]);
    const original = JSON.stringify(contract);
    const schema = structuredCorrectionSchema(contract, catalog);
    expect(new Ajv().compile(schema)(draft())).toBe(true);
    expect(JSON.stringify(contract)).toBe(original);
    expect(schema.required).toContain("draftArtifacts");
  });

  it.each(["top-level citation", "criterion citation", "top-level tool", "criterion tool", "criterion ID", "extra field", "oversize draft"])("refuses %s outside the immutable and observed contract", change => {
    const validate = new Ajv().compile(structuredCorrectionSchema(delegationResultJsonSchema([criterion]), catalog));
    const value = draft();
    if (change === "top-level citation") value.evidenceIds = [serviceHash];
    if (change === "criterion citation") value.acceptanceChecks[0].evidenceIds = [serviceHash];
    if (change === "top-level tool") value.toolExecutionIds = ["foreign-execution"];
    if (change === "criterion tool") value.acceptanceChecks[0].toolExecutionIds = ["foreign-execution"];
    if (change === "criterion ID") value.acceptanceChecks[0].criterionId = "criterion:invented";
    if (change === "extra field") Object.assign(value, { published: true });
    if (change === "oversize draft") value.draftArtifacts[0].content = "x".repeat(6001);
    expect(validate(value)).toBe(false);
  });

  it("keeps exact available citations distinct from service hashes and tool receipts", () => {
    const citationId = "knowledge:vendor-b";
    const validate = new Ajv().compile(structuredCorrectionSchema(delegationResultJsonSchema([criterion]), { ...catalog, citationIds: [citationId] }));
    const value = draft();
    value.evidenceIds = [citationId]; value.acceptanceChecks[0].evidenceIds = [citationId];
    expect(validate(value)).toBe(true);
    value.acceptanceChecks[0].evidenceIds = [serviceHash];
    expect(validate(value)).toBe(false);
  });

  it("allows an honest blocked result with no receipts and never fabricates a tool ID", () => {
    const validate = new Ajv().compile(structuredCorrectionSchema(delegationResultJsonSchema([criterion]), { citationIds: [], governedTools: [] }));
    const value = draft(); value.toolExecutionIds = []; value.acceptanceChecks[0].toolExecutionIds = []; value.acceptanceChecks[0].passed = false;
    value.draftArtifacts = [];
    expect(validate(value)).toBe(true);
    value.toolExecutionIds = [executionId]; expect(validate(value)).toBe(false);
  });

  it("does not widen legacy contracts that have no draft field", () => {
    const schema = delegationResultJsonSchema([criterion]) as { properties: Record<string, unknown> };
    delete schema.properties.draftArtifacts;
    const validate = new Ajv().compile(structuredCorrectionSchema(schema, catalog));
    expect(validate(draft())).toBe(false);
  });
});
