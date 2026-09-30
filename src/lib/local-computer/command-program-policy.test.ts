import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import commandProgramPolicy from "@/lib/local-computer/command-program-policy.json";
import { localComputerRunCommandInputSchema } from "@/lib/local-computer/contracts";
import { getGovernedTool } from "@/lib/tools/registry";
import {
  COMMAND_PROGRAM_POLICY_TARGETS,
  commandProgramPolicyOutputs,
  commandProgramPolicyProblems,
} from "../../../scripts/generate-command-program-policy.mjs";

const command = {
  workspaceId: `local_workspace_${"a".repeat(32)}`,
  arguments: ["status", "--short"],
  relativeDirectory: ".",
  timeoutSeconds: 10,
};
const refusedExecutables = [
  "bash",
  "sudo",
  "env",
  "osascript",
  "perl",
  "defaults",
  "curl",
  "Git",
  "/usr/bin/git",
];

describe("command program policy", () => {
  it("lists plain program names once, in order, apart from refused targets", () => {
    expect(commandProgramPolicyProblems(commandProgramPolicy)).toEqual([]);
    expect(commandProgramPolicy.programs).toEqual(
      expect.arrayContaining(["git", "node", "npm", "python3", "true"]),
    );
    expect(commandProgramPolicy.refusedTargets).toEqual(
      expect.arrayContaining(["bash", "env", "open", "osascript", "sh", "sudo", "zsh"]),
    );
    for (const policy of [
      { ...commandProgramPolicy, programs: ["git", "awk"] },
      { ...commandProgramPolicy, programs: ["git", "git"] },
      { ...commandProgramPolicy, programs: ["Git"] },
      { ...commandProgramPolicy, programs: ["bin/git"] },
      { ...commandProgramPolicy, programs: [] },
      { ...commandProgramPolicy, programs: ["sh"] },
      { ...commandProgramPolicy, shells: [] },
    ]) {
      expect(commandProgramPolicyProblems(policy)).not.toEqual([]);
    }
  });

  it("is copied unchanged into every native validator", async () => {
    const outputs = await commandProgramPolicyOutputs();

    expect(outputs.map((output) => output.file)).toEqual(
      COMMAND_PROGRAM_POLICY_TARGETS.map((target) => target.file),
    );
    for (const output of outputs) {
      expect(output.current, output.file).toBe(output.expected);
    }
  });

  it("gates each native validator on its copy", async () => {
    const [helper, app, bridge] = await Promise.all(
      COMMAND_PROGRAM_POLICY_TARGETS.map((target) => readFile(target.file, "utf8")),
    );

    expect(helper).toContain("let executableURL = CommandProgramPolicy.resolve(executable)");
    expect(helper).toContain("guard programs.contains(name) else { return nil }");
    expect(helper).toContain(
      "guard !refusedTargets.contains(resolved.lastPathComponent.lowercased())",
    );
    expect(app).toContain("Self.commandPrograms.contains(executable),");
    expect(bridge).toContain("_commandPrograms.contains(executable) &&");
  });

  it("lets the server accept only listed programs", () => {
    for (const executable of ["git", "npm", "python3", "true"]) {
      expect(
        localComputerRunCommandInputSchema.safeParse({ ...command, executable }).success,
        executable,
      ).toBe(true);
    }
    for (const executable of refusedExecutables) {
      expect(
        localComputerRunCommandInputSchema.safeParse({ ...command, executable }).success,
        executable,
      ).toBe(false);
    }
    expect(
      localComputerRunCommandInputSchema
        .safeParse({ ...command, executable: "perl" })
        .error?.issues.map((issue) => issue.message),
    ).toEqual(["Only listed development and file programs can run on This Mac."]);
  });

  it("offers the model only listed programs", () => {
    const properties = getGovernedTool("local.macos.command.run")?.inputSchema
      .properties as Record<string, { enum?: unknown }> | undefined;

    expect(properties?.executable?.enum).toEqual(commandProgramPolicy.programs);
  });
});
