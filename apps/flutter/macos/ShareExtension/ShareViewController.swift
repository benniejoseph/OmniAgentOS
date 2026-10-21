import AppKit
import UniformTypeIdentifiers

final class ShareViewController: NSViewController {
  private typealias IntakeError = SharedCaptureHandoff.Failure
  private static let maximumFiles = SharedCaptureHandoff.maximumFiles
  private static let maximumFileBytes = SharedCaptureHandoff.maximumFileBytes
  private static let supportedExtensions = SharedCaptureHandoff.supportedExtensions

  /// Serializes provider callbacks and expiry. Late provider results cannot write
  /// into a canceled preparation or turn a partial selection into success.
  private final class Preparation {
    private let lock = NSRecursiveLock()
    private var active = true
    private var lease: SharedCaptureHandoff.Lock?
    private let staging: URL
    private var entries: [SharedCaptureHandoff.Entry] = []
    private var completed = Set<Int>()
    private let count: Int
    private let completion: (Result<SharedCaptureHandoff.Prepared, Error>) -> Void

    init(count: Int, completion: @escaping (Result<SharedCaptureHandoff.Prepared, Error>) -> Void) throws {
      self.count = count
      self.completion = completion
      let prepared = try SharedCaptureHandoff.prepareStaging(root: SharedCaptureHandoff.stagingRoot(), count: count)
      lease = prepared.0
      staging = prepared.1
    }

    func store(_ data: Data, name: String) throws -> SharedCaptureHandoff.Entry {
      lock.lock(); defer { lock.unlock() }
      guard active, SharedCaptureHandoff.safeName(name), !data.isEmpty,
            data.count <= SharedCaptureHandoff.maximumFileBytes else { throw IntakeError.invalid }
      try SharedCaptureHandoff.publish(data, to: staging.appendingPathComponent(name))
      return .init(name: name, size: data.count, sha256: SharedCaptureHandoff.digest(data))
    }

    func receive(_ result: Result<SharedCaptureHandoff.Entry, Error>, index: Int) {
      lock.lock(); defer { lock.unlock() }
      guard active, completed.insert(index).inserted else { return }
      switch result {
      case .failure(let error): fail(error)
      case .success(let entry):
        entries.append(entry)
        guard completed.count == count else { return }
        do {
          let prepared = try SharedCaptureHandoff.commitStaging(staging, entries: entries)
          active = false
          lease = nil
          completion(.success(prepared))
        } catch { fail(error) }
      }
    }

    func fail(_ error: Error) {
      lock.lock(); defer { lock.unlock() }
      guard active else { return }
      active = false
      try? FileManager.default.removeItem(at: staging)
      lease = nil
      completion(.failure(error))
    }
  }

  private let statusLabel = NSTextField(labelWithString: "Open these files in Capture. Asael encrypts them when they enter your queue.")
  private let addButton = NSButton(title: "Add to Asael", target: nil, action: nil)
  private let cancelButton = NSButton(title: "Cancel", target: nil, action: nil)
  private var isWorking = false
  private var pending: SharedCaptureHandoff.Prepared?
  private var deliveryGeneration = 0

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
    if let pending {
      beginWorking("Opening Capture…")
      deliver(pending)
      return
    }
    let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
      .flatMap { $0.attachments ?? [] }
    guard !providers.isEmpty else {
      show(error: IntakeError.invalid)
      return
    }
    guard providers.count <= Self.maximumFiles else {
      statusLabel.textColor = .systemRed
      statusLabel.stringValue = "Select no more than 25 files. None of this selection was added."
      return
    }
    beginWorking("Preparing the complete selection…")
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self else { return }
      do {
        let preparation = try Preparation(count: providers.count) { result in
          DispatchQueue.main.async {
            switch result {
            case .success(let prepared):
              self.pending = prepared
              self.deliver(prepared)
            case .failure(let error): self.failed(error)
            }
          }
        }
        for (index, provider) in providers.enumerated() {
          self.stage(provider, index: index, preparation: preparation) { result in
            preparation.receive(result, index: index)
          }
        }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 60) {
          preparation.fail(IntakeError.invalid)
        }
      } catch { DispatchQueue.main.async { self.failed(error) } }
    }
  }

  private func beginWorking(_ text: String) {
    isWorking = true
    addButton.isEnabled = false
    cancelButton.isEnabled = false
    statusLabel.textColor = .secondaryLabelColor
    statusLabel.stringValue = text
  }

  private func failed(_ error: Error) {
    isWorking = false
    addButton.title = pending == nil ? "Add to Asael" : "Retry"
    cancelButton.title = pending == nil ? "Cancel" : "Close"
    addButton.isEnabled = true
    cancelButton.isEnabled = true
    show(error: error)
  }

  private func show(error: Error) {
    statusLabel.textColor = .systemRed
    // Provider and filesystem errors may include private paths. Keep these out
    // of both UI and logs; the complete selection is retained or rejected.
    statusLabel.stringValue = (error as? IntakeError)?.localizedDescription ?? IntakeError.invalid.localizedDescription
  }

  private func deliver(_ prepared: SharedCaptureHandoff.Prepared) {
    deliveryGeneration += 1
    let generation = deliveryGeneration
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let host = try SharedCaptureHandoff.verifiedContainingApplication()
        // A previous negative receipt must not be mistaken for this retry's
        // result. An accepted receipt is permanent and can complete immediately.
        if let outcome = try SharedCaptureHandoff.readAcknowledgment(prepared),
           ["accepted", "finished"].contains(outcome) {
          DispatchQueue.main.async { self.accepted(prepared, outcome: outcome) }
          return
        }
        try? FileManager.default.removeItem(at: prepared.directory.appendingPathComponent(SharedCaptureHandoff.acknowledgment))
        DispatchQueue.main.async {
          let configuration = NSWorkspace.OpenConfiguration()
          configuration.activates = true
          configuration.addsToRecentItems = false
          NSWorkspace.shared.open([prepared.document], withApplicationAt: host, configuration: configuration) { application, error in
            DispatchQueue.main.async {
              guard generation == self.deliveryGeneration else { return }
              guard error == nil, application != nil else { self.failed(IntakeError.unavailable); return }
              self.awaitAcceptance(prepared, generation: generation, deadline: Date().addingTimeInterval(20))
            }
          }
        }
      } catch { DispatchQueue.main.async { self.failed(error) } }
    }
  }

  private func awaitAcceptance(_ prepared: SharedCaptureHandoff.Prepared, generation: Int, deadline: Date) {
    guard generation == deliveryGeneration else { return }
    DispatchQueue.global(qos: .utility).async {
      let result = Result { try SharedCaptureHandoff.readAcknowledgment(prepared) }
      DispatchQueue.main.async {
        guard generation == self.deliveryGeneration else { return }
        switch result {
        case .success(let outcome) where outcome == "accepted" || outcome == "finished":
          self.accepted(prepared, outcome: outcome!)
        case .success("capacity"): self.failed(IntakeError.capacity)
        case .success("ledgerFull"): self.failed(IntakeError.ledgerFull)
        case .success("rejected"): self.failed(IntakeError.invalid)
        case .failure: self.failed(IntakeError.invalid)
        default:
          guard Date() < deadline else { self.failed(IntakeError.unconfirmed); return }
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            self.awaitAcceptance(prepared, generation: generation, deadline: deadline)
          }
        }
      }
    }
  }

  private func accepted(_ prepared: SharedCaptureHandoff.Prepared, outcome: String) {
    statusLabel.stringValue = outcome == "finished" ? "This share was already handled in Capture." : "Files are ready in Capture."
    pending = nil
    SharedCaptureHandoff.removeTemporary(prepared)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) {
      self.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }
  }

  private func stage(
    _ provider: NSItemProvider,
    index: Int,
    preparation: Preparation,
    completion: @escaping (Result<SharedCaptureHandoff.Entry, Error>) -> Void
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
          completion(.failure(IntakeError.invalid))
          return
        }
        completion(self.copy(url, suggestedName: provider.suggestedName, index: index, preparation: preparation))
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
          completion(.failure(IntakeError.invalid))
          return
        }
        let preferredExtension = UTType(typeIdentifier)?.preferredFilenameExtension
        let suggested = Self.suggestedFilename(
          provider.suggestedName,
          fallbackIndex: index,
          preferredExtension: preferredExtension
        )
        completion(self.copy(url, suggestedName: suggested, index: index, preparation: preparation))
      }
      return
    }

    if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
      provider.loadDataRepresentation(forTypeIdentifier: UTType.plainText.identifier) { data, error in
        completion(self.write(data, error: error, name: "shared-text-\(index + 1).txt", preparation: preparation))
      }
      return
    }

    completion(.failure(IntakeError.invalid))
  }

  private func copy(
    _ source: URL,
    suggestedName: String?,
    index: Int,
    preparation: Preparation
  ) -> Result<SharedCaptureHandoff.Entry, Error> {
    let didAccess = source.startAccessingSecurityScopedResource()
    defer { if didAccess { source.stopAccessingSecurityScopedResource() } }
    return Result {
      guard let name = Self.safeFilename(suggestedName ?? source.lastPathComponent, index: index) else {
        throw IntakeError.invalid
      }
      let bytes = try SharedCaptureHandoff.read(source, maximum: Self.maximumFileBytes)
      return try preparation.store(bytes, name: name)
    }
  }

  private func write(
    _ data: Data?,
    error: Error?,
    name: String,
    preparation: Preparation
  ) -> Result<SharedCaptureHandoff.Entry, Error> {
    Result {
      guard error == nil, let data else { throw IntakeError.invalid }
      return try preparation.store(data, name: name)
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
