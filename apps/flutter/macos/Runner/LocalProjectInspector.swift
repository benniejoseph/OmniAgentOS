import Foundation

/// Read-only project inspection for an owner-selected security-scoped folder.
/// No shell, network access, hooks, external diff drivers, or implicit checkout.
enum LocalProjectInspector {
  struct CommandOutput {
    let code: Int32
    let data: Data
    let truncated: Bool
  }

  static func inspect(root: URL) throws -> [String: Any] {
    let probe = try git(root, ["rev-parse", "--is-inside-work-tree"])
    guard probe.code == 0, text(probe).trimmingCharacters(in: .whitespacesAndNewlines) == "true" else {
      return ["isRepository": false, "branch": "", "detached": false,
              "remotes": [], "changes": [], "files": [], "truncated": false]
    }
    let branch = try git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    let head = branch.code == 0 ? branch : try git(root, ["rev-parse", "--short", "HEAD"])
    let remotes = try git(root, ["config", "--local", "--get-regexp", "^remote\\..*\\.url$"])
    let prefix = try git(root, ["rev-parse", "--show-prefix"])
    let folderPrefix = text(prefix).trimmingCharacters(in: .newlines)
    let status = try git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all", "--", "."])
    let files = try git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."])
    guard status.code == 0, files.code == 0 else { throw InspectionError.unavailable }
    let parsedFiles = completeNullRecords(text(files))
    let parsedChanges = parseChanges(text(status))
    return [
      "isRepository": true,
      "branch": clean(text(head).trimmingCharacters(in: .whitespacesAndNewlines), limit: 240),
      "detached": branch.code != 0,
      "remotes": parseRemotes(text(remotes)),
      "changes": parsedChanges.prefix(2_000).compactMap { change -> [String: String]? in
        guard let path = change["path"], path.hasPrefix(folderPrefix) else { return nil }
        return ["path": String(path.dropFirst(folderPrefix.count)), "status": change["status"]!]
      },
      "files": Array(parsedFiles.filter(validRelativePath).prefix(2_000)),
      "truncated": status.truncated || files.truncated || parsedFiles.count > 2_000 || parsedChanges.count > 2_000,
    ]
  }

  static func read(root: URL, path: String, changes: Bool) throws -> [String: Any] {
    guard validRelativePath(path) else { throw InspectionError.invalidPath }
    let canonicalRoot = root.resolvingSymlinksInPath().standardizedFileURL
    let requested = root.appendingPathComponent(path)
    let url = requested.deletingLastPathComponent().resolvingSymlinksInPath()
      .appendingPathComponent(requested.lastPathComponent).resolvingSymlinksInPath().standardizedFileURL
    guard url.path.hasPrefix(canonicalRoot.path + "/") else { throw InspectionError.invalidPath }
    if changes {
      let staged = try git(root, ["diff", "--no-ext-diff", "--no-textconv", "--cached", "--", path])
      let working = try git(root, ["diff", "--no-ext-diff", "--no-textconv", "--", path])
      guard staged.code == 0, working.code == 0 else { throw InspectionError.unavailable }
      let content = (text(staged).isEmpty ? "" : "Staged changes\n" + text(staged)) +
        (text(working).isEmpty ? "" : "Working changes\n" + text(working))
      if !content.isEmpty {
        return ["path": path, "content": String(content.prefix(128 * 1_024)), "truncated": staged.truncated || working.truncated || content.count > 128 * 1_024, "binary": false]
      }
      // Untracked files have no Git diff. Show their actual current contents.
    }
    guard (try url.resourceValues(forKeys: [.isRegularFileKey])).isRegularFile == true else {
      throw InspectionError.invalidPath
    }
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    let data = try handle.read(upToCount: 128 * 1_024 + 1) ?? Data()
    let binary = data.contains(0) || String(data: data.prefix(128 * 1_024), encoding: .utf8) == nil
    return ["path": path, "content": binary ? "" : String(decoding: data.prefix(128 * 1_024), as: UTF8.self),
            "truncated": data.count > 128 * 1_024, "binary": binary]
  }

  static func completeNullRecords(_ output: String) -> [String] {
    // Git's -z output terminates every record. A bounded read may end inside
    // the last filename, which must never become an actionable partial path.
    output.split(separator: "\0", omittingEmptySubsequences: false).dropLast().map(String.init)
  }

  static func parseChanges(_ output: String) -> [[String: String]] {
    let fields = completeNullRecords(output)
    var index = 0
    var result = [[String: String]]()
    while index < fields.count, result.count < 2_001 {
      let entry = String(fields[index]); index += 1
      guard entry.count >= 4 else { continue }
      let status = String(entry.prefix(2))
      let path = String(entry.dropFirst(3))
      if status.contains("R") || status.contains("C") {
        guard index < fields.count else { break }
        index += 1
      }
      if validRelativePath(path) { result.append(["path": path, "status": status]) }
    }
    return result
  }

  static func parseRemotes(_ output: String) -> [[String: String]] {
    output.split(separator: "\n").prefix(32).compactMap { line in
      guard let space = line.firstIndex(where: { $0.isWhitespace }) else { return nil }
      let key = String(line[..<space])
      guard key.hasPrefix("remote."), key.hasSuffix(".url") else { return nil }
      let raw = String(line[line.index(after: space)...]).trimmingCharacters(in: .whitespaces)
      var safe = raw
      if var url = URLComponents(string: raw), url.scheme != nil, url.host != nil {
        url.user = nil; url.password = nil; url.query = nil; url.fragment = nil
        safe = url.string ?? "Remote configured"
      } else if let at = raw.lastIndex(of: "@") {
        // SCP-style SSH remotes: retain host:path, never a user or credential.
        safe = String(raw[raw.index(after: at)...])
      } else if raw.contains("://") {
        safe = "Remote configured"
      }
      return ["name": clean(String(key.dropFirst(7).dropLast(4)), limit: 120),
              "url": clean(safe, limit: 500)]
    }
  }

  static func validRelativePath(_ path: String) -> Bool {
    !path.isEmpty && path.utf8.count <= 4_096 && !path.hasPrefix("/") &&
      !path.split(separator: "/").contains(where: { $0 == ".." || $0 == ".git" }) &&
      !path.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f })
  }

  private static func clean(_ text: String, limit: Int) -> String {
    String(String.UnicodeScalarView(text.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7f })).prefix(limit).description
  }
  private static func text(_ output: CommandOutput) -> String { String(decoding: output.data, as: UTF8.self) }

  private static func git(_ root: URL, _ arguments: [String]) throws -> CommandOutput {
    var filterOverrides = [String]()
    if arguments.first == "status" || arguments.first == "diff" {
      // Status/diff can execute a configured clean/process filter while hashing
      // changed files. Inspect its names as data and disable every such driver.
      let filters = try git(root, ["config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"])
      let keys = text(filters).split(separator: "\n").map(String.init)
      guard !filters.truncated, keys.count <= 256, keys.allSatisfy({
        $0.hasPrefix("filter.") && !$0.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f })
      }) else { throw InspectionError.unavailable }
      for key in keys { filterOverrides += ["-c", key + (key.hasSuffix(".required") ? "=false" : "=")] }
    }
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    process.currentDirectoryURL = root
    process.arguments = ["--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false",
                         "-c", "core.untrackedCache=false", "-c", "core.hooksPath=/dev/null",
                         "-c", "core.attributesFile=/dev/null"] + filterOverrides + arguments
    // Do not inherit GIT_DIR, GIT_WORK_TREE, injected config, pagers or credentials.
    process.environment = ["PATH": "/usr/bin:/bin", "GIT_OPTIONAL_LOCKS": "0",
                           "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1",
                           "GIT_CONFIG_GLOBAL": "/dev/null", "LC_ALL": "C"]
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    let buffer = BoundedBuffer(limit: 512 * 1_024)
    let readDone = DispatchSemaphore(value: 0)
    try process.run()
    try? pipe.fileHandleForWriting.close()
    DispatchQueue.global(qos: .userInitiated).async {
      defer { readDone.signal() }
      while true {
        let chunk = pipe.fileHandleForReading.availableData
        if chunk.isEmpty { break }
        buffer.append(chunk)
      }
    }
    let deadline = Date().addingTimeInterval(4)
    while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
    if process.isRunning {
      process.terminate()
      Thread.sleep(forTimeInterval: 0.05)
      if process.isRunning { kill(process.processIdentifier, SIGKILL) }
      _ = readDone.wait(timeout: .now() + 1)
      throw InspectionError.timedOut
    }
    process.waitUntilExit()
    guard readDone.wait(timeout: .now() + 1) == .success else { throw InspectionError.timedOut }
    let snapshot = buffer.snapshot()
    return CommandOutput(code: process.terminationStatus, data: snapshot.0, truncated: snapshot.1)
  }

  private final class BoundedBuffer: @unchecked Sendable {
    let limit: Int
    private let lock = NSLock()
    private var data = Data()
    private var truncated = false
    init(limit: Int) { self.limit = limit }
    func append(_ chunk: Data) {
      lock.lock(); defer { lock.unlock() }
      let room = max(0, limit - data.count)
      truncated = truncated || chunk.count > room
      data.append(chunk.prefix(room))
    }
    func snapshot() -> (Data, Bool) {
      lock.lock(); defer { lock.unlock() }
      return (data, truncated)
    }
  }

  enum InspectionError: Error { case unavailable, invalidPath, timedOut }
}
