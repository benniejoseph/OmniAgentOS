import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../core/network/api_exception.dart';
import 'builder_contracts.dart';
import 'builder_recovery_store.dart';
import '../../core/storage/ciphertext_recovery_broker.dart';
import 'builder_repository.dart';

class BuilderController extends ChangeNotifier {
  BuilderController(
    this.repository,
    this.recovery,
    this.projectId, {
    this.active = true,
    DateTime Function()? now,
  }) : now = now ?? DateTime.now {
    builderId(projectId, 'project');
    _scope = repository.access.owner?.key;
    repository.access.addListener(_accessChanged);
    repository.access.addSilentCloseListener(_silentlyInvalidate);
  }
  final BuilderRepository repository;
  final BuilderRecoveryStore recovery;
  final String projectId;
  final DateTime Function() now;
  BuilderAccess get access => repository.access;
  BuilderSnapshot? snapshot;
  BuilderFile? selectedFile, conflictingFile;
  bool fileFresh = false, localRecoveryPending = false;
  String? fileSessionId,
      selectedFilePath,
      deploymentId,
      releaseId,
      verificationId,
      repositoryId;
  String draft = '',
      search = '',
      branch = '',
      title = '',
      reviewNote = '',
      canvas = 'preview',
      rail = 'files';
  String confirmation = '', _confirmationBasis = '';
  List<BuilderTreeEntry> tree = const [];
  List<BuilderRepositoryChoice> repositories = const [];
  BuilderOutcome? outcome;
  String? readError,
      fileError,
      repositoriesError,
      actionError,
      recoveryError,
      commandOutput;
  bool active,
      loading = false,
      fileLoading = false,
      repositoriesLoading = false,
      fresh = false,
      recoveryReady = false,
      acting = false,
      outcomeReviewed = false;
  int _generation = 0, _fileGeneration = 0, _responseRevision = 0;
  String? _scope;
  bool _disposed = false, _authorityInvalidated = false;
  CancelToken? _read, _fileRead, _repositoryRead;
  Timer? _draftTimer;
  bool get available =>
      !_disposed &&
      !_authorityInvalidated &&
      active &&
      repository.authorityCurrent();
  bool get writable =>
      available &&
      access.writable &&
      fresh &&
      !loading &&
      !acting &&
      recoveryReady &&
      recoveryError == null &&
      !uncertain;
  bool get dirty => selectedFile != null && draft != selectedFile!.content;
  bool get fileMatchesSession =>
      fileFresh &&
      selectedFile != null &&
      fileSessionId == snapshot?.session?.id;
  bool get uncertain =>
      outcome?.state == BuilderOutcomeState.uncertain ||
      outcome?.state == BuilderOutcomeState.prepared;
  bool get running => snapshot?.session?.running ?? false;
  BuilderRecord? get selectedDeployment =>
      snapshot?.find('deployment', deploymentId);
  BuilderRecord? get selectedRelease => snapshot?.find('release', releaseId);
  BuilderRecord? get selectedVerification =>
      snapshot?.find('verification', verificationId);
  BuilderRecord? get deliveryVerification {
    final verification = selectedVerification,
        checkpoint = snapshot?.checkpoint;
    return verification != null &&
            checkpoint != null &&
            verification.status == 'passed' &&
            verification.text('checkpointId') == checkpoint.id &&
            verification.text('workspaceSha256') ==
                checkpoint.text('workspaceSha256') &&
            snapshot!.passingSentinel(verification)
        ? verification
        : null;
  }

  bool get canChangeWorkspace => writable && running;
  String get decisionBasis => jsonEncode([
    access.generation,
    snapshot?.session?.id,
    snapshot?.session?.revision,
    selectedFile?.path,
    selectedFile?.sha256,
    snapshot?.repository?.id,
    snapshot?.repository?.number('revision'),
    deploymentId,
    verificationId,
    releaseId,
    selectedRelease?.text('releaseDigest'),
  ]);
  String get confirmationBasis {
    final release = selectedRelease;
    return release == null
        ? ''
        : jsonEncode([
            snapshot?.session?.id,
            release.id,
            release.text('deploymentId'),
            release.text('releaseDigest'),
            release.text('expiresAt'),
            release.status,
          ]);
  }

  bool get canRelease {
    final release = selectedRelease;
    return canChangeWorkspace &&
        !dirty &&
        release != null &&
        release.text('deploymentId') == selectedDeployment?.id &&
        selectedDeployment?.status == 'ready' &&
        const {'review_pending', 'releasing'}.contains(release.status) &&
        (release.status != 'releasing' ||
            release.text('providerDeploymentId').isEmpty) &&
        builderDate(release.raw['expiresAt']).isAfter(now().toUtc()) &&
        release.object('migrationEvidence')['status'] == 'not_declared' &&
        confirmation == 'RELEASE' &&
        _confirmationBasis == confirmationBasis;
  }

  String get blocked => !available
      ? 'Builder access is unavailable. Check the current session.'
      : !access.writable
      ? 'Operator permission and the published native Builder operation are required for changes.'
      : recoveryError != null
      ? 'Protected local recovery is unavailable. Changes are blocked.'
      : uncertain
      ? 'The last effect is unconfirmed. Refresh and inspect its exact targets before a new decision.'
      : !fresh
      ? 'Refresh this exact workspace before changing it.'
      : acting
      ? 'A submitted action is pending.'
      : '';
  void _notify() {
    if (!_disposed && !_authorityInvalidated) {
      notifyListeners();
    }
  }

  bool _current(int generation) => available && generation == _generation;
  void _cancelReads() {
    _read?.cancel();
    _fileRead?.cancel();
    _repositoryRead?.cancel();
  }

  void _accessChanged() {
    if (_disposed || _authorityInvalidated) {
      return;
    }
    _generation++;
    _fileGeneration++;
    _cancelReads();
    fresh = fileFresh = false;
    loading = fileLoading = repositoriesLoading = false;
    confirmation = _confirmationBasis = '';
    outcomeReviewed = false;
    if (outcome?.state == BuilderOutcomeState.prepared) {
      outcome = outcome!.change(
        BuilderOutcomeState.uncertain,
        detail: 'Authority changed after preparation. Inspect the server before another decision.',
      );
    }
    acting = false;
    if (_scope != access.owner?.key || access.closed) {
      _clearPrivate();
      _scope = access.owner?.key;
    }
    _notify();
    if (available) {
      unawaited(initialize());
    }
  }

  void _clearPrivate() {
    _draftTimer?.cancel();
    _responseRevision++;
    snapshot = null;
    selectedFile = conflictingFile = null;
    fileFresh = localRecoveryPending = false;
    fileSessionId = selectedFilePath = deploymentId = releaseId =
        verificationId = repositoryId = null;
    draft = search = branch = title = reviewNote = confirmation =
        _confirmationBasis = '';
    canvas = 'preview';
    rail = 'files';
    tree = const [];
    repositories = const [];
    outcome = null;
    readError = fileError = repositoriesError = actionError = recoveryError =
        commandOutput = null;
    recoveryReady = false;
  }

  void setActive(bool value, {bool notify = true}) {
    if (_disposed || active == value) {
      return;
    }
    active = value;
    _generation++;
    _cancelReads();
    fresh = fileFresh = false;
    loading = fileLoading = repositoriesLoading = false;
    confirmation = _confirmationBasis = '';
    if (outcome?.state == BuilderOutcomeState.prepared) {
      outcome = outcome!.change(
        BuilderOutcomeState.uncertain,
        detail: 'View closed while an action was pending.',
      );
    }
    acting = false;
    if (notify) {
      _notify();
    }
  }

  void _silentlyInvalidate() => invalidateAuthority(notify: false);

  void invalidateAuthority({bool notify = true}) {
    if (_disposed || _authorityInvalidated) {
      return;
    }
    // This controller may be leaving a provider while its repository remains
    // valid for a replacement controller. Fence only this outgoing instance.
    _authorityInvalidated = true;
    active = false;
    _generation++;
    _fileGeneration++;
    _cancelReads();
    fresh = fileFresh = false;
    loading = fileLoading = repositoriesLoading = acting = false;
    _clearPrivate();
    if (notify) {
      notifyListeners();
    }
  }

  Future<void> initialize() async {
    if (!available || acting) {
      return;
    }
    final generation = _generation;
    if (!recoveryReady) {
      try {
        final stored = await recovery.read(access.owner!, projectId);
        if (!_current(generation)) {
          return;
        }
        if (stored != null) {
          final local = _recoveryValue;
          final previousOutcome = outcome;
          _restore({
            ...stored,
            if (localRecoveryPending)
              for (final field in [
                'filePath',
                'file',
                'fileSessionId',
                'draft',
                'branch',
                'title',
                'reviewNote',
                'repositoryId',
              ])
                field: local[field],
          });
          // A lost local save response never negates a received server receipt.
          if (previousOutcome?.state == BuilderOutcomeState.accepted &&
              outcome?.key == previousOutcome?.key) {
            outcome = previousOutcome;
          }
        }
        recoveryReady = true;
        recoveryError = null;
      } catch (error) {
        if (!_current(generation)) {
          return;
        }
        recoveryError = '$error';
        _notify();
      }
    }
    await refresh();
  }

  void _restore(BuilderJson value) {
    builderRequire(
      value['schemaVersion'] == 1 && value['projectId'] == projectId,
    );
    canvas = builderMember(value['canvas'], ['preview', 'code']);
    rail = builderMember(value['rail'], [
      'files',
      'checkpoints',
      'activity',
      'delivery',
    ]);
    for (final (field, kind) in [
      ('deploymentId', 'deployment'),
      ('releaseId', 'release'),
      ('verificationId', 'verification'),
    ]) {
      if (value[field] != null) {
        builderId(value[field], kind);
      }
    }
    deploymentId = value['deploymentId'] as String?;
    releaseId = value['releaseId'] as String?;
    verificationId = value['verificationId'] as String?;
    selectedFilePath = value['filePath'] == null
        ? null
        : builderPath(value['filePath']);
    if (value['file'] != null) {
      final raw = builderMap(value['file']);
      selectedFile = BuilderFile.parse(raw, builderPath(raw['path']));
      fileSessionId = builderId(value['fileSessionId'], 'session');
      draft = builderText(value['draft'], max: 500000, empty: true);
    }
    branch = builderText(value['branch'], max: 120, empty: true);
    title = builderText(value['title'], max: 180, empty: true);
    reviewNote = builderText(value['reviewNote'], max: 8000, empty: true);
    repositoryId = value['repositoryId'] as String?;
    if (repositoryId != null) {
      builderRequire(RegExp(r'^\d{1,24}$').hasMatch(repositoryId!));
    }
    outcome = value['outcome'] == null
        ? null
        : BuilderOutcome.parse(builderMap(value['outcome']));
    outcomeReviewed = false;
  }

  BuilderJson get _recoveryValue => {
    'schemaVersion': 1,
    'projectId': projectId,
    'canvas': canvas,
    'rail': rail,
    'deploymentId': deploymentId,
    'releaseId': releaseId,
    'verificationId': verificationId,
    'repositoryId': repositoryId,
    'filePath': selectedFilePath,
    'file': selectedFile?.json,
    'fileSessionId': fileSessionId,
    'draft': draft,
    'branch': branch,
    'title': title,
    'reviewNote': reviewNote,
    'outcome': outcome?.json,
  };
  Future<void> persist() async {
    if (_disposed || !repository.authorityCurrent() || !recoveryReady) {
      return;
    }
    _draftTimer?.cancel();
    final generation = access.generation, owner = access.owner!;
    final frozen = freezeBuilder(_recoveryValue) as BuilderJson;
    try {
      await recovery.write(
        owner,
        projectId,
        frozen,
        isCurrent: () =>
            !_disposed &&
            repository.authorityCurrent() &&
            generation == access.generation &&
            access.owner?.key == owner.key,
      );
      if (!_disposed &&
          repository.authorityCurrent() &&
          generation == access.generation) {
        recoveryError = null;
        if (jsonEncode(_recoveryValue) == jsonEncode(frozen)) {
          localRecoveryPending = false;
        }
      }
    } catch (error) {
      if (!_disposed &&
          repository.authorityCurrent() &&
          generation == access.generation) {
        recoveryError = '$error';
        if (error is RecoveryStorageChanged ||
            error is RecoveryStorageUnknown) {
          recoveryReady = false;
        }
      }
      rethrow;
    } finally {
      if (!_disposed &&
          repository.authorityCurrent() &&
          generation == access.generation) {
        _notify();
      }
    }
  }

  void editDraft(String value) {
    if (!available || acting || value.length > 500000) {
      return;
    }
    draft = value;
    _changedDraft();
  }

  void editHandoff({String? nextBranch, String? nextTitle, String? nextNote}) {
    if (!available || acting) {
      return;
    }
    branch = nextBranch ?? branch;
    title = nextTitle ?? title;
    reviewNote = nextNote ?? reviewNote;
    _changedDraft();
  }

  void _changedDraft() {
    localRecoveryPending = true;
    _notify();
    _draftTimer?.cancel();
    _draftTimer = Timer(
      const Duration(milliseconds: 300),
      () => unawaited(persist().catchError((Object _) {})),
    );
  }

  void choose({
    String? nextCanvas,
    String? nextRail,
    String? deployment,
    String? release,
    String? verification,
    String? repositoryChoice,
  }) {
    if (!available || acting) {
      return;
    }
    if (nextCanvas != null) {
      canvas = builderMember(nextCanvas, ['preview', 'code']);
    }
    if (nextRail != null) {
      rail = builderMember(nextRail, [
        'files',
        'checkpoints',
        'activity',
        'delivery',
      ]);
    }
    if (deployment != null) {
      deploymentId = builderId(deployment, 'deployment');
    }
    if (release != null) {
      releaseId = builderId(release, 'release');
    }
    if (verification != null) {
      verificationId = builderId(verification, 'verification');
    }
    if (repositoryChoice != null) {
      builderRequire(repositories.any((row) => row.id == repositoryChoice));
      repositoryId = repositoryChoice;
    }
    confirmation = _confirmationBasis = '';
    _changedDraft();
  }

  void confirm(String value) {
    if (!available || acting) {
      return;
    }
    confirmation = value;
    _confirmationBasis = confirmationBasis;
    _notify();
  }

  Future<void> refresh() async {
    if (!available || acting) {
      return;
    }
    final generation = ++_generation, revision = _responseRevision;
    _read?.cancel();
    final cancel = _read = CancelToken();
    loading = true;
    fresh = false;
    readError = null;
    _notify();
    try {
      final value = await repository.snapshot(projectId, cancel);
      if (!_current(generation) || revision != _responseRevision) {
        return;
      }
      snapshot = value;
      fresh = true;
      deploymentId ??= value.records('deployment').firstOrNull?.id;
      releaseId ??= value.records('release').firstOrNull?.id;
      verificationId ??=
          value.deliveryVerification?.id ??
          value.records('verification').firstOrNull?.id;
      if (_confirmationBasis != confirmationBasis) {
        confirmation = _confirmationBasis = '';
      }
      outcomeReviewed = uncertain;
      if (value.session?.running == true) {
        final entries = await repository.tree(
          projectId,
          value.session!.id,
          cancel,
        );
        if (!_current(generation)) {
          return;
        }
        tree = entries;
        {
          final path =
              selectedFilePath ??
              entries
                  .where((row) => row.path == 'app/page.tsx')
                  .firstOrNull
                  ?.path ??
              entries.where((row) => row.kind == 'file').firstOrNull?.path;
          if (path != null) {
            final fileGeneration = ++_fileGeneration;
            final currentFile = await repository.file(
              projectId,
              value.session!.id,
              path,
              cancel,
            );
            if (!_current(generation) || fileGeneration != _fileGeneration) {
              return;
            }
            selectedFilePath = path;
            if (selectedFile == null ||
                !dirty ||
                fileSessionId == value.session!.id &&
                    currentFile.content == draft) {
              selectedFile = currentFile;
              draft = currentFile.content;
              fileSessionId = value.session!.id;
              conflictingFile = null;
              fileFresh = true;
            } else if (fileSessionId == value.session!.id &&
                currentFile.sha256 == selectedFile!.sha256) {
              fileFresh = true;
              conflictingFile = null;
            } else {
              conflictingFile = currentFile;
              fileFresh = false;
            }
          }
        }
      }
      if (_current(generation)) {
        await persist();
      }
    } catch (error) {
      if (_current(generation)) {
        readError = '$error';
        fresh = false;
        if (error is ApiException &&
            const [401, 403, 404].contains(error.statusCode)) {
          snapshot = null;
        }
      }
    } finally {
      if (_current(generation)) {
        loading = false;
        _notify();
      }
    }
  }

  Future<void> openFile(String path, {bool allowDiscard = false}) async {
    if (!available || acting || !running || dirty && !allowDiscard) {
      return;
    }
    builderPath(path);
    final generation = _generation,
        fileGeneration = ++_fileGeneration,
        session = snapshot!.session!;
    _fileRead?.cancel();
    final cancel = _fileRead = CancelToken();
    fileLoading = true;
    fileError = null;
    selectedFilePath = path;
    _notify();
    try {
      final file = await repository.file(projectId, session.id, path, cancel);
      if (!_current(generation) ||
          fileGeneration != _fileGeneration ||
          cancel.isCancelled ||
          snapshot?.session?.id != session.id) {
        return;
      }
      selectedFile = file;
      fileSessionId = session.id;
      draft = file.content;
      fileFresh = true;
      conflictingFile = null;
      await persist();
    } catch (error) {
      if (_current(generation) &&
          fileGeneration == _fileGeneration &&
          !cancel.isCancelled) {
        fileFresh = false;
        fileError = '$error';
      }
    } finally {
      if (_current(generation) &&
          fileGeneration == _fileGeneration &&
          !cancel.isCancelled) {
        fileLoading = false;
        _notify();
      }
    }
  }

  Future<void> searchFiles(String value) async {
    if (!available || acting || !running) {
      return;
    }
    search = value;
    final generation = _generation;
    _fileRead?.cancel();
    final cancel = _fileRead = CancelToken();
    fileLoading = true;
    fileError = null;
    _notify();
    try {
      final entries = await repository.tree(
        projectId,
        snapshot!.session!.id,
        cancel,
        query: value.trim().isEmpty ? null : value,
      );
      if (_current(generation) && !cancel.isCancelled) {
        tree = entries;
      }
    } catch (error) {
      if (_current(generation) && !cancel.isCancelled) {
        fileError = '$error';
      }
    } finally {
      if (_current(generation) && !cancel.isCancelled) {
        fileLoading = false;
        _notify();
      }
    }
  }

  Future<void> loadRepositories() async {
    if (!available || acting) {
      return;
    }
    final generation = _generation;
    _repositoryRead?.cancel();
    final cancel = _repositoryRead = CancelToken();
    repositoriesLoading = true;
    repositoriesError = null;
    _notify();
    try {
      final rows = await repository.repositories(projectId, cancel);
      if (_current(generation) && !cancel.isCancelled) {
        repositories = rows;
        repositoryId ??= snapshot?.repository?.text('repositoryId');
        repositoryId ??= rows.firstOrNull?.id;
      }
    } catch (error) {
      if (_current(generation) && !cancel.isCancelled) {
        repositoriesError = '$error';
      }
    } finally {
      if (_current(generation) && !cancel.isCancelled) {
        repositoriesLoading = false;
        _notify();
      }
    }
  }

  Future<void> resolveFileConflict({required bool keepDraft}) async {
    if (!available ||
        acting ||
        conflictingFile == null ||
        snapshot?.session == null) {
      return;
    }
    selectedFile = conflictingFile;
    conflictingFile = null;
    fileSessionId = snapshot!.session!.id;
    fileFresh = true;
    if (!keepDraft) {
      draft = selectedFile!.content;
    }
    await persist();
    _notify();
  }

  Future<void> allowNewDecision() async {
    if (!available ||
        !fresh ||
        !recoveryReady ||
        recoveryError != null ||
        acting ||
        !outcomeReviewed ||
        !uncertain) {
      return;
    }
    outcome = null;
    outcomeReviewed = false;
    _responseRevision++;
    await persist();
    _notify();
  }

  Future<BuilderJson?> _act(
    BuilderJson request, {
    bool workspace = true,
  }) async {
    if (!writable || workspace && !running) {
      return null;
    }
    validateBuilderAction(request);
    final generation = _generation;
    final owner = access.owner!;
    final revision = ++_responseRevision;
    final frozen = freezeBuilder(request) as BuilderJson;
    final key =
        'native-builder-${List.generate(24, (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0')).join()}';
    outcome = BuilderOutcome(
      key: key,
      submitted: frozen,
      at: now().toUtc(),
      state: BuilderOutcomeState.prepared,
    );
    acting = true;
    actionError = null;
    outcomeReviewed = false;
    _notify();
    bool dispatched = false;
    try {
      // Persist the immutable intent before a provider can observe the request.
      await persist();
      if (!_current(generation) ||
          !access.writable ||
          access.owner?.key != owner.key) {
        return null;
      }
      dispatched = true;
      final response = await repository.mutate(projectId, frozen, key);
      if (!_current(generation) || revision != _responseRevision) {
        return null;
      }
      final receipt = builderMap(response['serviceReceipt']);
      outcome = outcome!.change(
        BuilderOutcomeState.accepted,
        receipt: builderHash(receipt['receiptSha256']),
      );
      await persist();
      return response;
    } catch (error) {
      if (_current(generation) && revision == _responseRevision) {
        final storageUncertain =
            error is RecoveryStorageChanged || error is RecoveryStorageUnknown;
        final rejected =
            !dispatched && !storageUncertain ||
            error is ApiException &&
                const [400, 401, 403, 404, 422, 429].contains(error.statusCode);
        if (outcome?.state != BuilderOutcomeState.accepted) {
          outcome = outcome!.change(
            rejected
                ? BuilderOutcomeState.rejected
                : BuilderOutcomeState.uncertain,
            detail: '$error'.length > 4000
                ? '$error'.substring(0, 4000)
                : '$error',
          );
        }
        actionError = outcome?.state == BuilderOutcomeState.accepted
            ? 'The action response was accepted; protected recovery could not be updated. $error'
            : '$error';
        await persist().catchError((Object _) {});
      }
      return null;
    } finally {
      if (_current(generation)) {
        acting = false;
        _notify();
      }
    }
  }

  Future<void> _perform(
    BuilderJson request, {
    bool workspace = true,
    bool replaceFile = false,
  }) async {
    final response = await _act(request, workspace: workspace);
    if (response == null || !available) {
      return;
    }
    if (replaceFile) {
      fileFresh = false;
    }
    if (response['deployment'] is Map) {
      deploymentId = builderId(
        builderMap(response['deployment'])['id'],
        'deployment',
      );
    }
    if (response['release'] is Map) {
      releaseId = builderId(builderMap(response['release'])['id'], 'release');
    }
    if (response['verification'] is Map) {
      verificationId = builderId(
        builderMap(response['verification'])['id'],
        'verification',
      );
    }
    if (request['action'] == 'command.run') {
      final result = builderMap(response['result']);
      final output = '${result['stdout']}\n${result['stderr']}'.trim();
      commandOutput = output.length > 64000
          ? 'Earlier output omitted.\n${output.substring(output.length - 64000)}'
          : output.isEmpty
          ? 'Command exit ${result['exitCode']}.'
          : output;
    }
    confirmation = _confirmationBasis = '';
    await refresh();
  }

  BuilderJson get _sessionInput => {'sessionId': snapshot!.session!.id};
  Future<void> create() => _perform({'action': 'create'}, workspace: false);
  Future<void> stop() async {
    if (!dirty && snapshot?.session != null) {
      await _perform({'action': 'stop', ..._sessionInput});
    }
  }

  Future<void> saveFile() async {
    if (!dirty || !fileMatchesSession || fileLoading) {
      return;
    }
    await _perform({
      'action': 'file.update',
      ..._sessionInput,
      'path': selectedFile!.path,
      'expectedSha256': selectedFile!.sha256,
      'content': draft,
    }, replaceFile: true);
  }

  Future<void> deleteFile() async {
    if (dirty || !fileMatchesSession) {
      return;
    }
    final response = await _act({
      'action': 'file.delete',
      ..._sessionInput,
      'path': selectedFile!.path,
      'expectedSha256': selectedFile!.sha256,
    });
    if (response != null && available) {
      selectedFile = null;
      selectedFilePath = null;
      fileSessionId = null;
      draft = '';
      await refresh();
    }
  }

  Future<void> command(String command) async {
    if (!dirty && snapshot?.session != null) {
      await _perform({
        'action': 'command.run',
        ..._sessionInput,
        'command': command,
      });
    }
  }

  Future<void> checkpoint() async {
    if (!dirty && snapshot?.session != null) {
      await _perform({
        'action': 'checkpoint.create',
        ..._sessionInput,
        'expectedSessionRevision': snapshot!.session!.revision,
        'reason': 'manual',
        'label': 'Native revision ${snapshot!.session!.revision}',
      });
    }
  }

  Future<void> restore(String checkpointId) async {
    final record = snapshot?.find('checkpoint', checkpointId);
    if (dirty ||
        record == null ||
        record.id == snapshot?.session?.checkpointId ||
        record.raw['expiresAt'] != null &&
            !builderDate(record.raw['expiresAt']).isAfter(now().toUtc())) {
      return;
    }
    await _perform({
      'action': 'checkpoint.restore',
      ..._sessionInput,
      'checkpointId': record.id,
      'expectedSessionRevision': snapshot!.session!.revision,
    }, replaceFile: true);
  }

  Future<void> verify() async {
    final checkpoint = snapshot?.checkpoint;
    if (dirty || checkpoint == null) {
      return;
    }
    await _perform({
      'action': 'verification.run',
      ..._sessionInput,
      'checkpointId': checkpoint.id,
      'expectedSessionRevision': snapshot!.session!.revision,
    });
  }

  Future<void> bindRepository() async {
    if (dirty ||
        repositoriesError != null ||
        !repositories.any((row) => row.id == repositoryId) ||
        snapshot?.session == null) {
      return;
    }
    await _perform({
      'action': 'repository.bind',
      ..._sessionInput,
      'repositoryId': repositoryId,
    });
  }

  Future<void> checkoutRepository() async {
    final binding = snapshot?.repository;
    if (dirty || binding == null) {
      return;
    }
    await _perform({
      'action': 'repository.checkout',
      ..._sessionInput,
      'repositoryBindingId': binding.id,
      'expectedBindingRevision': binding.number('revision'),
      'expectedSessionRevision': snapshot!.session!.revision,
    }, replaceFile: true);
  }

  Future<void> createPullRequest() async {
    final binding = snapshot?.repository,
        verification = deliveryVerification,
        checkpoint = snapshot?.checkpoint;
    if (dirty ||
        binding == null ||
        verification == null ||
        checkpoint == null ||
        title.trim().length < 3 ||
        branch.trim().isEmpty) {
      return;
    }
    await _perform({
      'action': 'delivery.create',
      ..._sessionInput,
      'repositoryBindingId': binding.id,
      'expectedBindingRevision': binding.number('revision'),
      'checkpointId': checkpoint.id,
      'verificationId': verification.id,
      'branchName': branch.trim(),
      'title': title.trim(),
      'body': reviewNote.trim(),
      'draft': true,
    });
  }

  Future<void> deployPreview() async {
    final verification = deliveryVerification,
        checkpoint = snapshot?.checkpoint;
    if (dirty || verification == null || checkpoint == null) {
      return;
    }
    await _perform({
      'action': 'deployment.preview',
      ..._sessionInput,
      'checkpointId': checkpoint.id,
      'verificationId': verification.id,
    });
  }

  Future<void> prepareRelease() async {
    final deployment = selectedDeployment;
    if (dirty || deployment?.status != 'ready') {
      return;
    }
    await _perform({
      'action': 'release.preview',
      ..._sessionInput,
      'deploymentId': deployment!.id,
    });
  }

  Future<void> releaseProduction() async {
    if (!canRelease) {
      return;
    }
    final release = selectedRelease!;
    await _perform({
      'action': 'release.production',
      ..._sessionInput,
      'releaseId': release.id,
      'releaseDigest': release.text('releaseDigest'),
      'confirmation': 'RELEASE',
    });
  }

  Future<void> refreshEvidence(String kind) async {
    final record = kind == 'release' ? selectedRelease : selectedDeployment;
    if (record == null || snapshot?.session == null) {
      return;
    }
    await _perform({
      'action': '$kind.refresh',
      ..._sessionInput,
      '${kind}Id': record.id,
    }, workspace: false);
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _cancelReads();
    _draftTimer?.cancel();
    repository.access.removeListener(_accessChanged);
    repository.access.removeSilentCloseListener(_silentlyInvalidate);
    _clearPrivate();
    super.dispose();
  }
}
