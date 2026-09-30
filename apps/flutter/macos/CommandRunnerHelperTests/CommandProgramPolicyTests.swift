import Darwin
import Foundation

@main
private enum CommandProgramPolicyTests {
  static func main() {
    listedNames()
    resolution()
  }

  private static func listedNames() {
    for name in ["git", "node", "npm", "python3", "rg", "true"] {
      expect(CommandProgramPolicy.programs.contains(name), "\(name) is a listed program")
    }
    for name in [
      "bash", "sh", "zsh", "sudo", "env", "xargs", "osascript", "open", "security",
      "launchctl", "perl", "defaults", "curl", "Git", "GIT",
    ] {
      expect(!CommandProgramPolicy.programs.contains(name), "\(name) is not a listed program")
    }
    expect(
      CommandProgramPolicy.programs.isDisjoint(with: CommandProgramPolicy.refusedTargets),
      "no listed program is also a refused target"
    )
  }

  private static func resolution() {
    let files = FileManager.default
    let scratchRoot = ProcessInfo.processInfo.environment["TMPDIR"].map {
      URL(fileURLWithPath: $0, isDirectory: true)
    } ?? files.temporaryDirectory
    let directory = scratchRoot
      .appendingPathComponent("asael-command-policy-\(UUID().uuidString)", isDirectory: true)
    guard (try? files.createDirectory(at: directory, withIntermediateDirectories: false)) != nil
    else { fail("the scratch directory is created") }
    defer { try? files.removeItem(at: directory) }

    func link(_ name: String, to target: String) {
      guard (try? files.createSymbolicLink(
        atPath: directory.appendingPathComponent(name).path,
        withDestinationPath: target
      )) != nil else { fail("\(name) links to \(target)") }
    }
    let upperCaseShell = directory.appendingPathComponent("ZSH").path
    guard (try? Data("#!/bin/sh\n".utf8).write(to: URL(fileURLWithPath: upperCaseShell))) != nil,
      (try? files.setAttributes([.posixPermissions: 0o755], ofItemAtPath: upperCaseShell)) != nil
    else { fail("an executable named ZSH is created") }
    link("true", to: "/usr/bin/true")
    link("jq", to: "/bin/zsh")
    link("cat", to: "/bin/ZSH")
    link("awk", to: upperCaseShell)
    link("perl", to: "/usr/bin/true")
    let directories = [directory.path]

    expect(
      CommandProgramPolicy.resolve("true", in: directories)?.path == "/usr/bin/true",
      "a listed program resolves through a link to its real file"
    )
    expect(
      CommandProgramPolicy.resolve("jq", in: directories) == nil,
      "a listed name that links to a shell finds nothing"
    )
    expect(
      CommandProgramPolicy.resolve("cat", in: directories) == nil,
      "a listed name that links to a shell in other case finds nothing"
    )
    expect(
      CommandProgramPolicy.resolve("awk", in: directories) == nil,
      "a listed name that links to a file named for a shell in other case finds nothing"
    )
    expect(
      CommandProgramPolicy.resolve("perl", in: directories) == nil,
      "an unlisted name finds nothing even when the file exists"
    )
    expect(
      CommandProgramPolicy.resolve("TRUE", in: directories) == nil,
      "a listed name in other case finds nothing"
    )
    expect(
      CommandProgramPolicy.resolve("rg", in: directories) == nil,
      "a listed program that is not installed finds nothing"
    )
    expect(
      CommandProgramPolicy.resolve("true")?.path == "/usr/bin/true",
      "the system search directories find a listed program"
    )
  }

  private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else { fail(message) }
  }

  private static func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("FAILED: \(message)\n".utf8))
    exit(1)
  }
}
