import Foundation

@main
enum LocalProjectInspectorTests {
  static func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw NSError(domain: "LocalProjectInspectorTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
  }
  @discardableResult static func git(_ root: URL, _ args: [String]) throws -> String {
    let task = Process(), output = Pipe()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    task.currentDirectoryURL = root
    task.arguments = ["-c", "user.name=Asael Test", "-c", "user.email=test@example.invalid"] + args
    task.standardOutput = output; task.standardError = FileHandle.nullDevice
    try task.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    task.waitUntilExit()
    try check(task.terminationStatus == 0, "Git fixture failed")
    return String(decoding: data, as: UTF8.self)
  }
  static func main() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("asael-project-inspector-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try check(try LocalProjectInspector.inspect(root: root)["isRepository"] as? Bool == false, "A plain folder was reported as Git")
    try git(root, ["init", "-b", "main"])
    let unborn = try LocalProjectInspector.inspect(root: root)
    try check(unborn["branch"] as? String == "main", "Unborn branch was lost")
    try FileManager.default.createDirectory(at: root.appendingPathComponent("src"), withIntermediateDirectories: true)
    try "before\n".write(to: root.appendingPathComponent("src/hello.txt"), atomically: true, encoding: .utf8)
    try git(root, ["add", "."]); try git(root, ["commit", "-m", "Fixture"])
    try git(root, ["remote", "add", "origin", "https://user:secret-token@example.test/team/project.git?token=hidden#secret"])
    try "after\n".write(to: root.appendingPathComponent("src/hello.txt"), atomically: true, encoding: .utf8)
    try "new\n".write(to: root.appendingPathComponent("new file.txt"), atomically: true, encoding: .utf8)
    let before = try git(root, ["status", "--porcelain=v1"])
    let snapshot = try LocalProjectInspector.inspect(root: root)
    let remotes = snapshot["remotes"] as! [[String: String]]
    try check(remotes.first?["url"] == "https://example.test/team/project.git", "Remote credentials were not removed")
    let changes = snapshot["changes"] as! [[String: String]]
    try check(changes.contains { $0["path"] == "src/hello.txt" }, "Tracked change missing")
    try check(changes.contains { $0["path"] == "new file.txt" && $0["status"] == "??" }, "Untracked file missing")
    let subfolder = try LocalProjectInspector.inspect(root: root.appendingPathComponent("src"))
    try check((subfolder["changes"] as! [[String: String]]).map { $0["path"]! } == ["hello.txt"], "Subfolder escaped its selected path")
    let file = try LocalProjectInspector.read(root: root, path: "src/hello.txt", changes: false)
    try check(file["content"] as? String == "after\n", "File preview changed content")
    let diff = try LocalProjectInspector.read(root: root, path: "src/hello.txt", changes: true)
    try check((diff["content"] as! String).contains("+after"), "Working diff missing")
    try git(root, ["add", "src/hello.txt"])
    let staged = try LocalProjectInspector.read(root: root, path: "src/hello.txt", changes: true)
    try check((staged["content"] as! String).contains("Staged changes"), "Staged diff missing")
    try git(root, ["reset", "--quiet", "HEAD"])
    try check(try git(root, ["status", "--porcelain=v1"]) == before, "Inspection modified the checkout")
    try check(!LocalProjectInspector.validRelativePath("../escape"), "Traversal accepted")
    try check(!LocalProjectInspector.validRelativePath(".git/config"), "Git internals accepted")
    try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("outside"), withDestinationURL: root.deletingLastPathComponent())
    do {
      _ = try LocalProjectInspector.read(root: root, path: "outside/any-file", changes: false)
      throw NSError(domain: "Expected symlink refusal", code: 1)
    } catch LocalProjectInspector.InspectionError.invalidPath {}
    let renamed = LocalProjectInspector.parseChanges("R  new.txt\0old.txt\0 M next.txt\0")
    try check(renamed.count == 2 && renamed.last?["path"] == "next.txt", "Rename parsing consumed another change")
    try check(LocalProjectInspector.parseChanges(" M complete.txt\0 M partial").count == 1, "Truncated filename became a change")
    try check(LocalProjectInspector.parseChanges("R  new.txt\0old").isEmpty, "Incomplete rename was accepted")
    try check(LocalProjectInspector.completeNullRecords("complete.txt\0partial") == ["complete.txt"], "Truncated file list exposed an incomplete path")
    let worktree = root.appendingPathComponent("linked")
    try git(root, ["worktree", "add", "-b", "feature/local", worktree.path])
    try check(try LocalProjectInspector.inspect(root: worktree)["branch"] as? String == "feature/local", "Linked worktree was not detected")
    try git(worktree, ["checkout", "--detach"])
    try check(try LocalProjectInspector.inspect(root: worktree)["detached"] as? Bool == true, "Detached HEAD was not reported")
    let marker = root.appendingPathComponent("filter-executed")
    try "*.txt filter=trap\n".write(to: root.appendingPathComponent(".gitattributes"), atomically: true, encoding: .utf8)
    try git(root, ["config", "filter.trap.clean", "/usr/bin/touch '\(marker.path)'"])
    try git(root, ["config", "filter.trap.required", "true"])
    _ = try LocalProjectInspector.inspect(root: root)
    _ = try LocalProjectInspector.read(root: root, path: "src/hello.txt", changes: true)
    try check(!FileManager.default.fileExists(atPath: marker.path), "Automatic Git inspection executed a repository filter")
    print("PASS: folder, branch, remotes, changes, subfolder scope, previews, staged diff, read-only state, symlink, rename, linked worktree and filter isolation")
  }
}
