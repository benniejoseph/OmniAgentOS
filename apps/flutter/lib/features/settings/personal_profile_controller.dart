import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/api_client.dart';
import '../../core/network/api_exception.dart';
import '../../core/network/native_workspace_access.dart';
import '../auth/application/biometric_session_lock_controller.dart';
import '../auth/application/session_controller.dart';
import 'personal_profile_repository.dart';

final personalProfileRepositoryProvider =
    Provider.autoDispose<PersonalProfileRepository?>((ref) {
      final access = ref.watch(nativeWorkspaceAccessProvider);
      if (access == null || !access.current || !ref.mounted) return null;
      final repository = PersonalProfileRepository(access);
      ref.listen(apiClientProvider, (_, next) {
        if (!identical(next, access.api)) repository.dispose();
      });
      ref.listen(sessionControllerProvider, (_, next) {
        final owner = next.value;
        if (next.isLoading ||
            next.hasError ||
            owner?.tenantId != access.authority.tenantId ||
            owner?.actorId != access.authority.actorId ||
            owner?.userId != access.authority.canonicalUserId ||
            owner?.role != access.authority.role)
          repository.dispose();
      });
      ref.listen(biometricSessionLockControllerProvider, (_, next) {
        if (next.state.blocksInteraction) repository.dispose();
      });
      ref.onDispose(repository.dispose);
      return repository;
    });

final personalProfileControllerProvider =
    Provider.autoDispose<PersonalProfileController?>((ref) {
      final repository = ref.watch(personalProfileRepositoryProvider);
      if (repository == null || !repository.current || !ref.mounted)
        return null;
      final controller = PersonalProfileController(repository);
      ref.onDispose(controller.dispose);
      unawaited(Future<void>.microtask(controller.refresh));
      return controller;
    });

class PersonalProfileController extends ChangeNotifier {
  PersonalProfileController(this.repository) {
    _detach = repository.observeInvalidation(() {
      invalidate();
      // The outgoing provider may be in Riverpod teardown.
      unawaited(Future<void>.microtask(_publish));
    });
  }
  final PersonalProfileRepository repository;
  void Function()? _detach;
  bool _disposed = false, _invalidated = false;
  int _generation = 0;
  int editorRevision = 0;
  PersonalProfileSnapshot? saved;
  Map<String, String> draft = {};
  bool enabled = false;
  bool loading = false, saving = false, reloadRequired = false;
  String? error, notice;

  bool get available =>
      !_disposed &&
      !_invalidated &&
      repository.current &&
      !_disposed &&
      !_invalidated;
  bool get busy => loading || saving;
  bool get dirty =>
      saved != null &&
      (enabled != saved!.enabled ||
          personalProfileFields.any(
            (field) => draft[field.key] != saved!.profile[field.key],
          ));
  bool get editable => available && saved != null && !busy && !reloadRequired;
  bool get canSave => editable && dirty;

  void _publish() {
    if (!_disposed) notifyListeners();
  }

  bool _current(int generation) => available && generation == _generation;

  void invalidate() {
    _invalidated = true;
    _generation++;
    saved = null;
    draft = {};
    enabled = false;
    loading = saving = reloadRequired = false;
    error = notice = null;
    editorRevision++;
  }

  void update(String key, String value) {
    if (!editable || !personalProfileFields.any((field) => field.key == key))
      return;
    draft = {...draft, key: value};
    notice = null;
    _publish();
  }

  void setEnabled(bool value) {
    if (!editable) return;
    enabled = value;
    notice = null;
    _publish();
  }

  void clearAll() {
    if (!editable) return;
    draft = {for (final field in personalProfileFields) field.key: ''};
    enabled = false;
    notice = null;
    editorRevision++;
    _publish();
  }

  void _accept(PersonalProfileSnapshot snapshot) {
    saved = snapshot;
    draft = Map.of(snapshot.profile);
    enabled = snapshot.enabled;
    reloadRequired = false;
    editorRevision++;
  }

  Future<void> refresh() async {
    if (!available || busy) return;
    final generation = ++_generation;
    loading = true;
    error = notice = null;
    _publish();
    try {
      final snapshot = await repository.read();
      if (!_current(generation)) return;
      _accept(snapshot);
    } catch (failure) {
      if (!_current(generation)) return;
      error = _accessFailure(failure)
          ? 'Your account access changed. Reopen Settings after signing in.'
          : 'Your saved profile could not be loaded. Check your connection and try again.';
      if (_accessFailure(failure)) {
        saved = null;
        draft = {};
        editorRevision++;
        reloadRequired = true;
      }
    } finally {
      if (_current(generation)) {
        loading = false;
        _publish();
      }
    }
  }

  Future<void> save() async {
    if (!canSave) return;
    final generation = ++_generation;
    final previous = saved!;
    final submitted = <String, String>{
      for (final field in personalProfileFields)
        field.key: (draft[field.key] ?? '').trim(),
    };
    final submittedEnabled = enabled;
    final random = Random.secure();
    final key =
        'profile-native:${List.generate(24, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0')).join()}';
    saving = true;
    error = notice = null;
    _publish();
    try {
      final snapshot = await repository.save(
        expectedRevision: previous.revision,
        enabled: submittedEnabled,
        profile: submitted,
        key: key,
      );
      if (!_current(generation)) return;
      _accept(snapshot);
      notice = submitted.values.every((value) => value.isEmpty)
          ? 'Your About me profile has been cleared.'
          : 'Saved across your devices. Applies to your next message or new voice conversation.';
    } catch (failure) {
      if (!_current(generation)) return;
      reloadRequired = true;
      error = failure is ApiException && failure.statusCode == 409
          ? 'Your profile changed elsewhere. Reload the saved version before making more changes.'
          : _accessFailure(failure)
          ? 'Your account access changed. Reopen Settings after signing in.'
          : 'The save could not be confirmed. Reload your saved profile before trying again.';
      if (_accessFailure(failure)) {
        saved = null;
        draft = {};
        editorRevision++;
      }
    } finally {
      if (_current(generation)) {
        saving = false;
        _publish();
      }
    }
  }

  bool _accessFailure(Object error) =>
      error is NativeAuthorityVerificationException ||
      error is ApiException && const [401, 403].contains(error.statusCode);

  @override
  void dispose() {
    _disposed = true;
    _detach?.call();
    _detach = null;
    invalidate();
    super.dispose();
  }
}
