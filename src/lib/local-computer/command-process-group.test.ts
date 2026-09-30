import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const helperFile = "apps/flutter/macos/CommandRunnerHelper/HelperMain.swift";
const hostFile = "apps/flutter/macos/Runner/AppDelegate.swift";
const suiteRunnerFile = "apps/flutter/tool/run_macos_policy_tests.sh";

function inOrder(source: string, parts: string[]) {
  const positions = parts.map((part) => source.indexOf(part));
  for (const [index, position] of positions.entries()) {
    expect(position, parts[index]).toBeGreaterThan(-1);
    if (index > 0) expect(position, parts[index]).toBeGreaterThan(positions[index - 1]!);
  }
}

// The group rules are covered by the Mac helper's CommandProcessGroup suite. A
// whole command run needs the signed app, so this checks that each run and each
// stop still goes through them.
describe("This Mac command process groups", () => {
  it("ends each command's group before reaping the command", async () => {
    const helper = await readFile(helperFile, "utf8");

    inOrder(helper, [
      "    let started = ActiveChildRegistry.shared.start {\n" +
        "      CommandProcessGroup.spawn(\n",
      "    try? stdoutPipe.fileHandleForWriting.close()\n" +
        "    try? stderrPipe.fileHandleForWriting.close()\n" +
        "    guard let leader = started else {\n",
      "    while !CommandProcessGroup.hasExited(leader) {\n",
      "    CommandProcessGroup.end(leader, grace: 0.25)\n" +
        "    ActiveChildRegistry.shared.clear(leader)\n" +
        "    let status = CommandProcessGroup.reap(leader)\n",
    ]);
    expect(helper.match(/CommandProcessGroup\.spawn\(/g)).toHaveLength(1);
    expect(helper.match(/CommandProcessGroup\.reap\(/g)).toHaveLength(1);
    expect(helper).not.toContain("Process()");
    expect(helper).not.toContain("setpgid");

    for (const rule of [
      "    let flags = POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK\n" +
        "      | POSIX_SPAWN_CLOEXEC_DEFAULT\n",
      "          posix_spawnattr_setpgroup(&attributes, 0) == 0,\n",
      "    guard waitid(P_PID, id_t(leader), &info, WEXITED | WNOHANG | WNOWAIT) == 0 else {\n",
      "  static func end(_ leader: pid_t, grace: TimeInterval) {\n" +
        "    guard leader > 1 else { return }\n",
    ]) {
      expect(helper).toContain(rule);
    }
  });

  it("ends the running command when the helper is stopped", async () => {
    const helper = await readFile(helperFile, "utf8");

    for (const rule of [
      "  func start(_ spawn: () -> pid_t?) -> pid_t? {\n" +
        "    lock.lock()\n" +
        "    defer { lock.unlock() }\n" +
        "    guard !stopping else { return nil }\n" +
        "    leader = spawn()\n",
      "  func terminate() {\n" +
        "    lock.lock()\n" +
        "    defer { lock.unlock() }\n" +
        "    stopping = true\n" +
        "    guard let leader else { return }\n" +
        "    CommandProcessGroup.end(leader, grace: 0.25)\n" +
        "  }\n",
      "      ActiveChildRegistry.shared.terminate()\n      _exit(143)\n",
      "      ActiveChildRegistry.shared.terminate()\n      _exit(130)\n",
    ]) {
      expect(helper).toContain(rule);
    }
  });

  it("has the app end the command's group when the helper stops too slowly", async () => {
    const host = await readFile(hostFile, "utf8");

    expect(host).toContain("  private static let commandHelperStopGrace: TimeInterval = 1.0\n");
    for (const rule of [
      "      terminating.terminate()\n" +
        "      let deadline = DispatchTime.now() + Self.commandHelperStopGrace\n" +
        "      DispatchQueue.main.asyncAfter(deadline: deadline) { [weak terminating] in\n" +
        "        guard let terminating, terminating.isRunning else { return }\n" +
        "        let helper = terminating.processIdentifier\n" +
        "        Self.killChildProcessGroups(of: helper)\n" +
        "        kill(helper, SIGKILL)\n" +
        "      }\n",
      "  private static func killChildProcessGroups(of parent: pid_t) {\n" +
        "    guard parent > 1 else { return }\n",
      "    guard bytes > 0 else { return }\n" +
        "    for child in children.prefix(Int(bytes) / MemoryLayout<pid_t>.stride) " +
        "where child > 1 {\n" +
        "      _ = kill(-child, SIGKILL)\n",
    ]) {
      expect(host).toContain(rule);
    }
    expect(host).not.toContain("setpgid");
  });

  it("runs the group suite with the other Mac policy suites", async () => {
    const suiteRunner = await readFile(suiteRunnerFile, "utf8");

    expect(suiteRunner).toContain(
      "task_run_suite CommandProcessGroupTests ASAEL_COMMAND_RUNNER_HELPER_TESTING \\\n" +
        '  "${task_command_runner_frameworks[@]}" \\\n' +
        '  "$task_macos_dir/CommandRunnerHelper/HelperMain.swift" \\\n' +
        '  "$task_macos_dir/CommandRunnerHelperTests/CommandProcessGroupTests.swift"\n',
    );
  });
});
