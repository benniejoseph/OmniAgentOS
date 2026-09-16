import AppKit
import UniformTypeIdentifiers

final class ShareViewController: NSViewController {
  private struct Manifest: Encodable {
    struct FileEntry: Encodable {
      let name: String
      let size: Int
    }

    let schemaVersion = 1
    let requestId: String
    let createdAt: String
    let files: [FileEntry]
  }

  private enum IntakeError: LocalizedError {
    case noSupportedItems
    case appGroupUnavailable
    case fileUnavailable
    case invalidFile
    case fileTooLarge

    var errorDescription: String? {
      switch self {
      case .noSupportedItems:
        return "No supported files were found."
      case .appGroupUnavailable:
        return "Asael's shared intake is unavailable in this build."
      case .fileUnavailable:
        return "A shared item could not be read."
      case .invalidFile:
        return "A shared item is empty, unsafe, or unsupported."
      case .fileTooLarge:
        return "Each shared file must be 5 MB or smaller."
      }
    }
  }

  private static let appGroupIdentifier = "group.app.omniagent.omniagent"
  private static let inboxName = "ShareInbox"
  private static let maximumFiles = 25
  private static let maximumFileBytes = 5 * 1_024 * 1_024
  private static let supportedExtensions = Set([
    "txt", "text", "md", "markdown", "csv", "tsv", "json", "jsonl", "ndjson",
    "html", "htm", "xml", "yaml", "yml", "log", "rtf", "tex", "sql", "js",
    "jsx", "ts", "tsx", "css", "scss", "sass", "less", "py", "rb", "go",
    "rs", "java", "kt", "swift", "sh", "zsh", "toml", "ini", "cfg", "conf",
    "srt", "vtt", "eml", "ics", "vcf", "ipynb", "png", "jpg", "jpeg",
    "webp", "mp3", "m4a", "wav", "ogg", "mp4", "webm", "xlsx", "xlsm",
    "pptx", "ppsx", "odt", "ods", "odp", "epub", "pdf", "docx",
  ])

  private let statusLabel = NSTextField(labelWithString: "Add these files to Asael's encrypted Capture queue.")
  private let addButton = NSButton(title: "Add to Asael", target: nil, action: nil)
  private let cancelButton = NSButton(title: "Cancel", target: nil, action: nil)
  private var isWorking = false

  override func loadView() {
    let root = NSView(frame: NSRect(x: 0, y: 0, width: 480, height: 210))
    root.wantsLayer = true
    root.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

    let icon = NSImageView(image: NSImage(systemSymbolName: "tray.and.arrow.down.fill", accessibilityDescription: "Capture") ?? NSImage())
    icon.contentTintColor = .controlAccentColor
    icon.translatesAutoresizingMaskIntoConstraints = false

    let title = NSTextField(labelWithString: "Capture with Asael")
    title.font = .systemFont(ofSize: 20, weight: .semibold)
    title.translatesAutoresizingMaskIntoConstraints = false

    statusLabel.font = .systemFont(ofSize: 13)
    statusLabel.textColor = .secondaryLabelColor
    statusLabel.maximumNumberOfLines = 3
    statusLabel.lineBreakMode = .byWordWrapping
    statusLabel.translatesAutoresizingMaskIntoConstraints = false

    addButton.target = self
    addButton.action = #selector(addToAsael)
    addButton.keyEquivalent = "\r"
    addButton.bezelStyle = .rounded
    addButton.translatesAutoresizingMaskIntoConstraints = false

    cancelButton.target = self
    cancelButton.action = #selector(cancel)
    cancelButton.bezelStyle = .rounded
    cancelButton.translatesAutoresizingMaskIntoConstraints = false

    for child in [icon, title, statusLabel, addButton, cancelButton] {
      root.addSubview(child)
    }
    NSLayoutConstraint.activate([
      icon.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24),
      icon.topAnchor.constraint(equalTo: root.topAnchor, constant: 25),
      icon.widthAnchor.constraint(equalToConstant: 28),
      icon.heightAnchor.constraint(equalToConstant: 28),
      title.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 12),
      title.centerYAnchor.constraint(equalTo: icon.centerYAnchor),
      title.trailingAnchor.constraint(lessThanOrEqualTo: root.trailingAnchor, constant: -24),
      statusLabel.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24),
      statusLabel.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
      statusLabel.topAnchor.constraint(equalTo: icon.bottomAnchor, constant: 20),
      cancelButton.leadingAnchor.constraint(greaterThanOrEqualTo: root.leadingAnchor, constant: 24),
      cancelButton.trailingAnchor.constraint(equalTo: addButton.leadingAnchor, constant: -10),
      cancelButton.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -22),
      addButton.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
      addButton.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -22),
      addButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 118),
    ])
    view = root
  }

  @objc private func cancel() {
    guard !isWorking else { return }
    extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
  }

  @objc private func addToAsael() {
    guard !isWorking else { return }
    let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
      .flatMap { $0.attachments ?? [] }
      .prefix(Self.maximumFiles)
    guard !providers.isEmpty else {
      show(error: IntakeError.noSupportedItems)
      return
    }

    isWorking = true
    addButton.isEnabled = false
    cancelButton.isEnabled = false
    statusLabel.stringValue = "Securing shared files…"
    stage(Array(providers)) { [weak self] result in
      DispatchQueue.main.async {
        guard let self else { return }
        switch result {
        case .success(let requestId):
          self.statusLabel.stringValue = "Queued securely. Opening Capture…"
          let url = URL(string: "asael://capture-shared?id=\(requestId)")!
          self.extensionContext?.open(url) { _ in
            self.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
          }
        case .failure(let error):
          self.isWorking = false
          self.addButton.isEnabled = true
          self.cancelButton.isEnabled = true
          self.show(error: error)
        }
      }
    }
  }

  private func show(error: Error) {
    statusLabel.textColor = .systemRed
    statusLabel.stringValue = error.localizedDescription
  }

  private func stage(
    _ providers: [NSItemProvider],
    completion: @escaping (Result<String, Error>) -> Void
  ) {
    let requestId = UUID().uuidString.lowercased()
    guard let container = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: Self.appGroupIdentifier
    ) else {
      completion(.failure(IntakeError.appGroupUnavailable))
      return
    }
    let inbox = container.appendingPathComponent(Self.inboxName, isDirectory: true)
    let staging = inbox.appendingPathComponent(".staging-\(requestId)", isDirectory: true)
    let destination = inbox.appendingPathComponent(requestId, isDirectory: true)
    do {
      try FileManager.default.createDirectory(
        at: staging,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
      )
    } catch {
      completion(.failure(error))
      return
    }

    let group = DispatchGroup()
    let lock = NSLock()
    var staged: [Manifest.FileEntry] = []
    var firstError: Error?

    for (index, provider) in providers.enumerated() {
      group.enter()
      stage(provider, index: index, in: staging) { result in
        lock.lock()
        switch result {
        case .success(let entry): staged.append(entry)
        case .failure(let error): firstError = firstError ?? error
        }
        lock.unlock()
        group.leave()
      }
    }

    group.notify(queue: .global(qos: .userInitiated)) {
      do {
        guard !staged.isEmpty else {
          throw firstError ?? IntakeError.noSupportedItems
        }
        staged.sort { $0.name < $1.name }
        let formatter = ISO8601DateFormatter()
        let manifest = Manifest(
          requestId: requestId,
          createdAt: formatter.string(from: Date()),
          files: staged
        )
        let data = try JSONEncoder().encode(manifest)
        try data.write(
          to: staging.appendingPathComponent("manifest.json"),
          options: [.atomic, .completeFileProtection]
        )
        try FileManager.default.moveItem(at: staging, to: destination)
        completion(.success(requestId))
      } catch {
        try? FileManager.default.removeItem(at: staging)
        completion(.failure(error))
      }
    }
  }

  private func stage(
    _ provider: NSItemProvider,
    index: Int,
    in directory: URL,
    completion: @escaping (Result<Manifest.FileEntry, Error>) -> Void
  ) {
    if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
      provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, error in
        if let error {
          completion(.failure(error))
          return
        }
        let url: URL?
        if let value = item as? URL {
          url = value
        } else if let value = item as? Data {
          url = URL(dataRepresentation: value, relativeTo: nil)
        } else {
          url = nil
        }
        guard let url else {
          completion(.failure(IntakeError.fileUnavailable))
          return
        }
        completion(self.copy(url, suggestedName: provider.suggestedName, index: index, to: directory))
      }
      return
    }

    if let typeIdentifier = provider.registeredTypeIdentifiers.first(where: { identifier in
      guard let type = UTType(identifier) else { return false }
      return type.conforms(to: .data) || type.conforms(to: .content)
    }) {
      provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { url, error in
        if let error {
          completion(.failure(error))
          return
        }
        guard let url else {
          completion(.failure(IntakeError.fileUnavailable))
          return
        }
        let preferredExtension = UTType(typeIdentifier)?.preferredFilenameExtension
        let suggested = Self.suggestedFilename(
          provider.suggestedName,
          fallbackIndex: index,
          preferredExtension: preferredExtension
        )
        completion(self.copy(url, suggestedName: suggested, index: index, to: directory))
      }
      return
    }

    if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
      provider.loadDataRepresentation(forTypeIdentifier: UTType.plainText.identifier) { data, error in
        completion(self.write(data, error: error, name: "shared-text-\(index + 1).txt", to: directory))
      }
      return
    }

    completion(.failure(IntakeError.invalidFile))
  }

  private func copy(
    _ source: URL,
    suggestedName: String?,
    index: Int,
    to directory: URL
  ) -> Result<Manifest.FileEntry, Error> {
    let didAccess = source.startAccessingSecurityScopedResource()
    defer { if didAccess { source.stopAccessingSecurityScopedResource() } }
    do {
      let attributes = try FileManager.default.attributesOfItem(atPath: source.path)
      guard attributes[.type] as? FileAttributeType == .typeRegular,
            let number = attributes[.size] as? NSNumber,
            number.intValue > 0
      else { throw IntakeError.invalidFile }
      guard number.intValue <= Self.maximumFileBytes else {
        throw IntakeError.fileTooLarge
      }
      let rawName = suggestedName ?? source.lastPathComponent
      guard let name = Self.safeFilename(rawName, index: index) else {
        throw IntakeError.invalidFile
      }
      let destination = directory.appendingPathComponent(name, isDirectory: false)
      try FileManager.default.copyItem(at: source, to: destination)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
      return .success(.init(name: name, size: number.intValue))
    } catch {
      return .failure(error)
    }
  }

  private func write(
    _ data: Data?,
    error: Error?,
    name: String,
    to directory: URL
  ) -> Result<Manifest.FileEntry, Error> {
    if let error { return .failure(error) }
    guard let data, !data.isEmpty else { return .failure(IntakeError.invalidFile) }
    guard data.count <= Self.maximumFileBytes else { return .failure(IntakeError.fileTooLarge) }
    do {
      let destination = directory.appendingPathComponent(name, isDirectory: false)
      try data.write(to: destination, options: [.atomic, .completeFileProtection])
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
      return .success(.init(name: name, size: data.count))
    } catch {
      return .failure(error)
    }
  }

  private static func suggestedFilename(
    _ name: String?,
    fallbackIndex: Int,
    preferredExtension: String?
  ) -> String {
    guard let name, !name.isEmpty else {
      let suffix = preferredExtension.map { ".\($0)" } ?? ".txt"
      return "shared-file-\(fallbackIndex + 1)\(suffix)"
    }
    guard (name as NSString).pathExtension.isEmpty, let preferredExtension else { return name }
    return "\(name).\(preferredExtension)"
  }

  private static func safeFilename(_ rawName: String, index: Int) -> String? {
    let trimmed = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty,
          trimmed != ".",
          trimmed != "..",
          (trimmed as NSString).lastPathComponent == trimmed,
          trimmed.count <= 170,
          trimmed.lengthOfBytes(using: .utf8) <= 225,
          !trimmed.unicodeScalars.contains(where: { scalar in
            scalar.value < 0x20 ||
              (scalar.value >= 0x7f && scalar.value <= 0x9f) ||
              (scalar.value >= 0x202a && scalar.value <= 0x202e) ||
              (scalar.value >= 0x2066 && scalar.value <= 0x2069)
          })
    else { return nil }
    let fileExtension = (trimmed as NSString).pathExtension.lowercased()
    guard supportedExtensions.contains(fileExtension) else { return nil }
    return String(format: "%02d-%@", index + 1, trimmed)
  }
}
