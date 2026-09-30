import Darwin
import Foundation

@main
private enum CommandProcessGroupTests {
  static func main() {
    // A suite that stops making progress fails instead of hanging.
    alarm(60)
    // The helper ignores SIGTERM. A command must inherit neither that nor a
    // blocked SIGTERM.
    signal(SIGTERM, SIG_IGN)
    var terminate = sigset_t()
    sigemptyset(&terminate)
    sigaddset(&terminate, SIGTERM)
    pthread_sigmask(SIG_BLOCK, &terminate, nil)
    setenv("ASAEL_COMMAND_GROUP_INHERITED", "yes", 1)

    let files = FileManager.default
    let scratchRoot = ProcessInfo.processInfo.environment["TMPDIR"].map {
      URL(fileURLWithPath: $0, isDirectory: true)
    } ?? files.temporaryDirectory
    let directory = scratchRoot
      .appendingPathComponent("asael-command-group-\(UUID().uuidString)", isDirectory: true)
    guard (try? files.createDirectory(at: directory, withIntermediateDirectories: false)) != nil
    else { fail("the scratch directory is created") }

    outputAndStatus(in: directory)
    signalDefaults(in: directory)
    stragglers(in: directory)
    departedLeader(in: directory)
    environmentAndDirectory(in: directory)
    descriptors(in: directory)
    registry(in: directory)
    try? files.removeItem(at: directory)
  }

  private struct Command {
    let leader: pid_t
    let output: Int32
    let errors: Int32
  }

  private static func spawn(
    _ program: String,
    _ arguments: [String],
    environment: [String: String] = ["PATH": "/usr/bin:/bin"],
    in directory: URL
  ) -> Command {
    var output: [Int32] = [0, 0]
    var errors: [Int32] = [0, 0]
    guard pipe(&output) == 0, pipe(&errors) == 0 else { fail("the pipes open") }
    let leader = CommandProcessGroup.spawn(
      URL(fileURLWithPath: program),
      arguments: arguments,
      environment: environment,
      directory: directory,
      output: output[1],
      errors: errors[1]
    )
    close(output[1])
    close(errors[1])
    guard let leader else { fail("\(program) starts") }
    return Command(leader: leader, output: output[0], errors: errors[0])
  }

  private static func sleeper(in directory: URL) -> pid_t? {
    let sink = open("/dev/null", O_WRONLY)
    guard sink >= 0 else { fail("/dev/null opens") }
    defer { close(sink) }
    return CommandProcessGroup.spawn(
      URL(fileURLWithPath: "/bin/sleep"),
      arguments: ["20"],
      environment: [:],
      directory: directory,
      output: sink,
      errors: sink
    )
  }

  private static func outputAndStatus(in directory: URL) {
    let command = spawn("/bin/sh", ["-c", "printf out; printf err >&2; exit 3"], in: directory)
    expect(readAll(command.output) == "out", "the command writes to its output")
    expect(readAll(command.errors) == "err", "the command writes its errors apart")
    expect(eventually { CommandProcessGroup.hasExited(command.leader) }, "the command exits")
    expect(kill(command.leader, 0) == 0, "checking for an exit leaves the command unreaped")
    expect(
      !CommandProcessGroup.isOccupied(command.leader),
      "an exited command alone does not occupy its group"
    )
    CommandProcessGroup.end(command.leader, grace: 0.25)
    expect(CommandProcessGroup.reap(command.leader) == 3, "reaping answers the exit code")
    expect(CommandProcessGroup.hasExited(command.leader), "a reaped command counts as exited")
  }

  private static func signalDefaults(in directory: URL) {
    let command = spawn("/bin/sleep", ["20"], in: directory)
    defer { close(command.output); close(command.errors) }
    expect(!CommandProcessGroup.hasExited(command.leader), "a running command has not exited")
    expect(getpgid(command.leader) == command.leader, "the command leads its own group")
    expect(getpgid(command.leader) != getpgrp(), "the command's group is not the helper's")
    expect(CommandProcessGroup.isOccupied(command.leader), "a running command occupies its group")
    let started = Date()
    CommandProcessGroup.end(command.leader, grace: 5)
    expect(
      Date().timeIntervalSince(started) < 2,
      "a command that stops on SIGTERM is not held for the whole grace"
    )
    expect(
      CommandProcessGroup.reap(command.leader) == SIGTERM,
      "the command stops on SIGTERM although the helper ignores and blocks it"
    )
  }

  private static func stragglers(in directory: URL) {
    let marker = directory.appendingPathComponent("stopped").path
    let polite = spawn(
      "/bin/sh",
      [
        "-c",
        "(trap 'echo stopped > \"$0\"; exit 0' TERM; n=0; "
          + "while [ $n -lt 400 ]; do /bin/sleep 0.05; n=$((n + 1)); done) "
          + ">/dev/null 2>&1 & echo $!",
        marker,
      ],
      in: directory
    )
    let reported = pid_t(readAll(polite.output).trimmingCharacters(in: .whitespacesAndNewlines))
    _ = readAll(polite.errors)
    guard let straggler = reported, straggler > 1 else { fail("the command reports its straggler") }
    expect(eventually { CommandProcessGroup.hasExited(polite.leader) }, "the command exits")
    expect(kill(straggler, 0) == 0, "the straggler outlives the command")
    expect(getpgid(straggler) == polite.leader, "the straggler stays in the command's group")
    expect(
      CommandProcessGroup.isOccupied(polite.leader),
      "a straggler occupies the group of an exited command"
    )
    CommandProcessGroup.end(polite.leader, grace: 5)
    expect(
      FileManager.default.fileExists(atPath: marker),
      "a straggler that stops on SIGTERM finishes before the group is killed"
    )
    expect(
      eventually { !CommandProcessGroup.isOccupied(polite.leader) },
      "ending the group ends a straggler that stops on SIGTERM"
    )
    expect(
      CommandProcessGroup.reap(polite.leader) == 0,
      "ending the group keeps the exit code of a command that finished"
    )

    let stubborn = spawn(
      "/bin/sh",
      ["-c", "(trap '' TERM; /bin/sleep 20) >/dev/null 2>&1 & echo $!"],
      in: directory
    )
    let holdout = pid_t(readAll(stubborn.output).trimmingCharacters(in: .whitespacesAndNewlines))
    _ = readAll(stubborn.errors)
    guard let holdout, holdout > 1 else { fail("the command reports its straggler") }
    expect(eventually { CommandProcessGroup.hasExited(stubborn.leader) }, "the command exits")
    expect(getpgid(holdout) == stubborn.leader, "the straggler stays in the command's group")
    CommandProcessGroup.end(stubborn.leader, grace: 0.25)
    expect(
      eventually { !CommandProcessGroup.isOccupied(stubborn.leader) },
      "a straggler that ignores SIGTERM is killed after the grace"
    )
    expect(CommandProcessGroup.reap(stubborn.leader) == 0, "the finished command is reaped")
  }

  private static func departedLeader(in directory: URL) {
    // A command that moves itself into the helper's group is signalled by its
    // process ID.
    let script = "$SIG{TERM} = @ARGV ? 'IGNORE' : sub { print \"stopped\\n\"; exit 0 }; "
      + "setpgrp(0, getpgrp(getppid())) or die; $| = 1; print \"moved\\n\"; sleep 20"
    let polite = spawn("/usr/bin/perl", ["-e", script], in: directory)
    defer { close(polite.output); close(polite.errors) }
    expect(readFirstLine(polite.output) == "moved", "the command leaves its group")
    expect(
      !CommandProcessGroup.isOccupied(polite.leader),
      "a command's group is empty once the command leaves it"
    )
    let started = Date()
    CommandProcessGroup.end(polite.leader, grace: 5)
    expect(
      Date().timeIntervalSince(started) < 2,
      "a command outside its group is not held for the whole grace"
    )
    expect(
      readFirstLine(polite.output) == "stopped",
      "a command outside its group gets SIGTERM and the grace to act on it"
    )
    expect(
      CommandProcessGroup.reap(polite.leader) == 0,
      "a command outside its group stops on SIGTERM"
    )

    let stubborn = spawn("/usr/bin/perl", ["-e", script, "ignore"], in: directory)
    defer { close(stubborn.output); close(stubborn.errors) }
    expect(readFirstLine(stubborn.output) == "moved", "the command leaves its group")
    CommandProcessGroup.end(stubborn.leader, grace: 0.25)
    expect(
      eventually { CommandProcessGroup.hasExited(stubborn.leader) },
      "a command outside its group that ignores SIGTERM is killed after the grace"
    )
    expect(
      CommandProcessGroup.reap(stubborn.leader) == SIGKILL,
      "a command outside its group that ignores SIGTERM is killed"
    )
  }

  private static func environmentAndDirectory(in directory: URL) {
    let command = spawn(
      "/bin/sh",
      [
        "-c",
        "pwd -P; printf '%s|%s' \"$ASAEL_COMMAND_GROUP_VALUE\" "
          + "\"${ASAEL_COMMAND_GROUP_INHERITED-unset}\"",
      ],
      environment: ["ASAEL_COMMAND_GROUP_VALUE": "given"],
      in: directory
    )
    guard let canonical = realpath(directory.path, nil) else { fail("the scratch path resolves") }
    let expected = String(cString: canonical) + "\ngiven|unset"
    free(canonical)
    expect(
      readAll(command.output) == expected,
      "the command runs in its directory with only the environment it is given"
    )
    expect(readAll(command.errors) == "", "the command reports no error")
    expect(eventually { CommandProcessGroup.hasExited(command.leader) }, "the command exits")
    CommandProcessGroup.end(command.leader, grace: 0.25)
    expect(CommandProcessGroup.reap(command.leader) == 0, "the command succeeds")
  }

  private static func descriptors(in directory: URL) {
    var inherited: [Int32] = [0, 0]
    guard pipe(&inherited) == 0 else { fail("a pipe opens") }
    defer { close(inherited[0]); close(inherited[1]) }
    let probe = spawn(
      "/bin/sh",
      [
        "-c",
        "if { true <&\(inherited[0]); } 2>/dev/null; then echo open; else echo closed; fi",
      ],
      in: directory
    )
    expect(readAll(probe.output) == "closed\n", "the command inherits no other descriptor")
    _ = readAll(probe.errors)
    expect(eventually { CommandProcessGroup.hasExited(probe.leader) }, "the probe exits")
    CommandProcessGroup.end(probe.leader, grace: 0.25)
    expect(CommandProcessGroup.reap(probe.leader) == 0, "the probe succeeds")

    let reader = spawn("/bin/cat", [], in: directory)
    expect(readAll(reader.output) == "", "the command reads an empty input")
    expect(readAll(reader.errors) == "", "the command's input is readable")
    expect(eventually { CommandProcessGroup.hasExited(reader.leader) }, "the reader exits")
    CommandProcessGroup.end(reader.leader, grace: 0.25)
    expect(CommandProcessGroup.reap(reader.leader) == 0, "the reader succeeds")
  }

  private final class Started: @unchecked Sendable {
    var leader: pid_t?
  }

  private static func registry(in directory: URL) {
    let stopped = ActiveChildRegistry()
    guard let running = stopped.start({ sleeper(in: directory) }) else { fail("a command starts") }
    stopped.terminate()
    expect(
      eventually { CommandProcessGroup.hasExited(running) },
      "stopping the helper ends the running command"
    )
    expect(CommandProcessGroup.reap(running) == SIGTERM, "the running command gets SIGTERM")
    var called = false
    expect(
      stopped.start({ called = true; return sleeper(in: directory) }) == nil && !called,
      "no command starts once a stop has begun"
    )

    let cleared = ActiveChildRegistry()
    guard let finished = cleared.start({ sleeper(in: directory) }) else { fail("a command starts") }
    cleared.clear(finished &+ 1)
    cleared.clear(finished)
    cleared.terminate()
    Thread.sleep(forTimeInterval: 0.1)
    expect(!CommandProcessGroup.hasExited(finished), "stopping signals no cleared command")
    CommandProcessGroup.end(finished, grace: 0.25)
    expect(CommandProcessGroup.reap(finished) == SIGTERM, "the cleared command is ended")

    let other = ActiveChildRegistry()
    guard let kept = other.start({ sleeper(in: directory) }) else { fail("a command starts") }
    other.clear(kept &+ 1)
    other.terminate()
    expect(
      eventually { CommandProcessGroup.hasExited(kept) },
      "clearing another command keeps this one to stop"
    )
    expect(CommandProcessGroup.reap(kept) == SIGTERM, "the kept command gets SIGTERM")

    // A stop that arrives while a command is starting waits for it, then ends it.
    let racing = ActiveChildRegistry()
    let started = Started()
    let entered = DispatchSemaphore(value: 0)
    let returned = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
      started.leader = racing.start {
        entered.signal()
        Thread.sleep(forTimeInterval: 0.3)
        return sleeper(in: directory)
      }
      returned.signal()
    }
    entered.wait()
    racing.terminate()
    returned.wait()
    guard let raced = started.leader else { fail("the starting command starts") }
    expect(
      CommandProcessGroup.hasExited(raced),
      "a stop that arrives while a command starts ends it"
    )
    expect(CommandProcessGroup.reap(raced) == SIGTERM, "the starting command gets SIGTERM")
  }

  private static func readAll(_ descriptor: Int32) -> String {
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4_096)
    while true {
      let count = read(descriptor, &buffer, buffer.count)
      if count > 0 {
        data.append(contentsOf: buffer[0..<count])
      } else if count == 0 || errno != EINTR {
        break
      }
    }
    close(descriptor)
    return String(decoding: data, as: UTF8.self)
  }

  private static func readFirstLine(_ descriptor: Int32) -> String {
    var line = Data()
    var byte: UInt8 = 0
    while line.count < 256 {
      let count = read(descriptor, &byte, 1)
      if count == 1 {
        if byte == 0x0a { break }
        line.append(byte)
      } else if count == 0 || errno != EINTR {
        break
      }
    }
    return String(decoding: line, as: UTF8.self)
  }

  private static func eventually(_ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(3)
    while !condition() {
      guard Date() < deadline else { return false }
      Thread.sleep(forTimeInterval: 0.01)
    }
    return true
  }

  private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else { fail(message) }
  }

  private static func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("FAILED: \(message)\n".utf8))
    exit(1)
  }
}
