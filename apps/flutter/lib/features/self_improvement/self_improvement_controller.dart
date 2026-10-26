import 'package:flutter/foundation.dart';

import '../../core/network/api_exception.dart';
import 'self_improvement_models.dart';
import 'self_improvement_repository.dart';

/// Private presentation state only. Execution and idempotency stay on the server.
class SelfImprovementController extends ChangeNotifier {
  SelfImprovementController(this.repository);
  final SelfImprovementRepositoryApi repository;
  SelfImprovementSnapshot? _snapshot;
  SelfImprovementCycle? _selectedCycle;
  SelfImprovementConfiguration? _confirmedConfiguration;
  SelfImprovementCycle? _confirmedCycle;
  String? _requestedCycleId, _error, _lastOutcome;
  List<SelfImprovementProject> _projects = const [];
  List<SelfImprovementRepositoryOption> _repositories = const [];
  bool loading = false,
      acting = false,
      setupLoading = false,
      refreshRequired = true,
      _disposed = false;
  int _epoch = 0;
  bool get current => !_disposed && repository.current;
  bool get canManage =>
      current &&
      repository.canManage &&
      !loading &&
      !acting &&
      !refreshRequired &&
      _snapshot != null;
  SelfImprovementSnapshot? get snapshot => current ? _snapshot : null;
  SelfImprovementCycle? get selectedCycle => current ? _selectedCycle : null;
  String? get requestedCycleId => current ? _requestedCycleId : null;
  String? get error => current ? _error : null;
  String? get lastOutcome => current ? _lastOutcome : null;
  List<SelfImprovementProject> get projects => current ? _projects : const [];
  List<SelfImprovementRepositoryOption> get repositories =>
      current ? _repositories : const [];
  void _emit() {
    if (!_disposed) notifyListeners();
  }

  String _message(Object error) => error is ApiException
      ? error.message
      : error is FormatException
      ? error.message
      : error is StateError
      ? error.message
      : 'The live outcome could not be confirmed. Refresh before continuing; no action will be replayed.';
  Future<void> refresh({String? cycleId}) async {
    if (!current || acting || loading) return;
    if (cycleId != null) {
      improvementRequire(
        RegExp(r'^self_cycle_[a-f0-9]{64}$').hasMatch(cycleId),
      );
    }
    if (cycleId != null) _requestedCycleId = cycleId;
    final epoch = ++_epoch;
    loading = true;
    _error = null;
    refreshRequired = true;
    _emit();
    try {
      final next = await repository.load();
      SelfImprovementCycle? detail;
      if (_requestedCycleId case final id?) {
        for (final cycle in next.cycles) {
          if (cycle.id == id) detail = cycle;
        }
        detail ??= await repository.loadCycle(id);
      }
      if (_confirmedConfiguration case final confirmed?) {
        improvementRequire(
          next.configurations.any(
            (c) => c.id == confirmed.id && c.generation >= confirmed.generation,
          ),
          'The latest read does not yet confirm the saved settings. Refresh before continuing.',
        );
      }
      if (_confirmedCycle case final confirmed?) {
        SelfImprovementCycle? observed = detail?.id == confirmed.id
            ? detail
            : null;
        for (final cycle in next.cycles) {
          if (cycle.id == confirmed.id) observed = cycle;
        }
        observed ??= await repository.loadCycle(confirmed.id);
        improvementRequire(
          observed != null && observed.revision >= confirmed.revision,
          'The latest read does not yet confirm the recorded cycle. Refresh before continuing.',
        );
      }
      if (!current || epoch != _epoch) return;
      _snapshot = next;
      _selectedCycle = detail;
      refreshRequired = false;
      if (_requestedCycleId != null && detail == null) {
        _error = 'This improvement is unavailable for the current account.';
      }
    } catch (error) {
      if (current && epoch == _epoch) _error = _message(error);
    } finally {
      if (!_disposed && epoch == _epoch) {
        loading = false;
        _emit();
      }
    }
  }

  Future<void> loadSetup() async {
    if (!current || setupLoading || acting) return;
    final epoch = _epoch;
    setupLoading = true;
    _error = null;
    _emit();
    try {
      final repos = await repository.loadRepositories();
      final values = await repository.loadProjects();
      if (!current || epoch != _epoch) return;
      _repositories = repos;
      _projects = values;
    } catch (error) {
      if (current && epoch == _epoch) _error = _message(error);
    } finally {
      if (!_disposed) {
        setupLoading = false;
        _emit();
      }
    }
  }

  SelfImprovementConfiguration _configuration(
    SelfImprovementConfiguration value,
  ) {
    improvementRequire(
      canManage,
      'Refresh the current owner configuration before changing it.',
    );
    final matches = _snapshot!.configurations.where(
      (c) =>
          c.id == value.id &&
          c.generation == value.generation &&
          c.policy.policySha256 == value.policy.policySha256,
    );
    improvementRequire(
      matches.length == 1,
      'The configuration changed. Refresh before continuing.',
    );
    return matches.single;
  }

  SelfImprovementCycle _cycle(SelfImprovementCycle value) {
    improvementRequire(
      canManage,
      'Refresh the current exact candidate before deciding.',
    );
    final values = [..._snapshot!.cycles, ?_selectedCycle];
    final matching = values.where(
      (c) =>
          c.id == value.id &&
          c.revision == value.revision &&
          c.candidate?.candidateSha256 == value.candidate?.candidateSha256 &&
          c.validation?.validationSha256 == value.validation?.validationSha256,
    );
    improvementRequire(
      matching.isNotEmpty,
      'The candidate changed. Refresh before continuing.',
    );
    return matching.first;
  }

  Future<bool> _mutate(String action, ImprovementJson input) async {
    improvementRequire(canManage, 'Refresh before submitting another action.');
    acting = true;
    _error = null;
    _lastOutcome = null;
    _emit();
    try {
      final result = await repository.mutate(
        action,
        input,
        newSelfImprovementIdempotencyKey(),
      );
      if (!current) return false;
      if (result.configuration != null) {
        _confirmedConfiguration = result.configuration;
      }
      if (result.cycle != null) _confirmedCycle = result.cycle;
      _lastOutcome = result.manualReleaseRequired
          ? 'manual_release_required'
          : result.outcome ?? action;
      if (result.cycle != null) {
        _requestedCycleId = result.cycle!.id;
        _selectedCycle = result.cycle;
      }
      // Even a confirmed mutation needs a fresh authoritative projection before
      // another action. No failed request is retried by this controller.
      acting = false;
      refreshRequired = true;
      await refresh();
      return current && !refreshRequired;
    } catch (error) {
      if (current) {
        _error = _message(error);
        refreshRequired = true;
      }
      return false;
    } finally {
      if (!_disposed) {
        acting = false;
        _emit();
      }
    }
  }

  Future<bool> configure(SelfImprovementConfigureInput input) async {
    improvementRequire(canManage);
    final existing = _snapshot!.configurations.where(
      (c) => c.projectId == input.projectId,
    );
    if (input.expectedGeneration != null) {
      improvementRequire(
        existing.length == 1 &&
            existing.single.generation == input.expectedGeneration,
      );
    } else {
      improvementRequire(existing.isEmpty);
    }
    return _mutate('configure', input.toJson());
  }

  Future<bool> run(SelfImprovementConfiguration config) {
    final c = _configuration(config);
    improvementRequire(
      !c.paused,
      'Resume the schedule before starting a cycle.',
    );
    return _mutate('run', {
      'configurationId': c.id,
      'expectedGeneration': c.generation,
    });
  }

  Future<bool> setPaused(SelfImprovementConfiguration config, bool paused) {
    final c = _configuration(config);
    improvementRequire(
      c.paused != paused,
      'The schedule already has this state.',
    );
    return _mutate('pause', {
      'configurationId': c.id,
      'expectedGeneration': c.generation,
      'paused': paused,
    });
  }

  Future<bool> review(SelfImprovementCycle cycle, String decision) {
    final c = _cycle(cycle);
    improvementRequire(
      decision == 'approve'
          ? c.canApprove
          : decision == 'reject' && c.canReject,
      'This exact review is not available.',
    );
    return _mutate('review', {
      'cycleId': c.id,
      'expectedRevision': c.revision,
      'candidateSha256': c.candidate!.candidateSha256,
      'validationSha256': c.validation!.validationSha256,
      'decision': decision,
    });
  }

  Future<bool> retrySetup(
    SelfImprovementConfiguration config,
    SelfImprovementCycle cycle,
  ) {
    final c = _configuration(config), failed = _cycle(cycle);
    improvementRequire(
      !c.paused && failed.canRetrySetup && failed.configurationId == c.id,
      'This setup failure is not eligible for an explicit retry.',
    );
    return _mutate('retry', {
      'configurationId': c.id,
      'expectedGeneration': c.generation,
      'failedCycleId': failed.id,
      'expectedRevision': failed.revision,
    });
  }

  Future<bool> stopNativeCheck(SelfImprovementCycle cycle) {
    final c = _cycle(cycle);
    improvementRequire(
      c.canStopNativeCheck &&
          c.nativeCheck?['requestSha256'] ==
              cycle.nativeCheck?['requestSha256'],
      'This held Mac check changed. Refresh before stopping it.',
    );
    return _mutate('stop_native_check', {
      'cycleId': c.id,
      'expectedRevision': c.revision,
      'requestId': c.nativeCheck!['requestId'],
      'requestSha256': c.nativeCheck!['requestSha256'],
    });
  }

  @override
  void dispose() {
    _disposed = true;
    _epoch++;
    _snapshot = null;
    _selectedCycle = null;
    _confirmedConfiguration = null;
    _confirmedCycle = null;
    _projects = const [];
    _repositories = const [];
    super.dispose();
  }
}
