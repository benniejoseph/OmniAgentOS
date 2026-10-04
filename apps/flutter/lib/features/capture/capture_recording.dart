import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import 'capture_controller.dart';
import 'capture_models.dart';

abstract interface class CaptureRecorder {
  Future<bool> hasPermission();
  Future<void> start();
  Future<bool> isRecording();
  Stream<bool> get recordingChanges;
  Future<CaptureAttachment?> stop();
  Future<void> cancel();
  Future<void> dispose();
}

/// Injectable native seams keep cancellation and plaintext cleanup testable
/// without starting a device microphone.
abstract interface class CaptureRecorderBackend {
  Future<bool> hasPermission();
  Future<bool> supportsWav();
  Future<void> start(String path);
  Future<String?> stop();
  Future<void> cancel();
  Future<bool> isRecording();
  Stream<bool> get recordingChanges;
  Future<void> dispose();
}

class _RecordBackend implements CaptureRecorderBackend {
  final AudioRecorder recorder = AudioRecorder();
  @override
  Future<bool> hasPermission() => recorder.hasPermission();
  @override
  Future<bool> supportsWav() => recorder.isEncoderSupported(AudioEncoder.wav);
  @override
  Future<void> start(String path) => recorder.start(
    const RecordConfig(
      encoder: AudioEncoder.wav,
      sampleRate: 16000,
      numChannels: 1,
    ),
    path: path,
  );
  @override
  Future<String?> stop() => recorder.stop();
  @override
  Future<void> cancel() => recorder.cancel();
  @override
  Future<bool> isRecording() => recorder.isRecording();
  @override
  Stream<bool> get recordingChanges =>
      recorder.onStateChanged().map((state) => state == RecordState.record);
  @override
  Future<void> dispose() => recorder.dispose();
}

abstract interface class CaptureRecordingFiles {
  Future<String> createDirectory();
  Future<CaptureAttachment> readOriginal(String directory, String path);
  Future<void> deleteDirectory(String directory);
  Future<void> retryCleanup();
}

class NativeCaptureRecordingFiles implements CaptureRecordingFiles {
  NativeCaptureRecordingFiles({
    Future<Directory> Function()? temporaryDirectory,
    Future<void> Function(Directory)? deleteDirectory,
  }) : _temporaryDirectory = temporaryDirectory ?? getTemporaryDirectory,
       _deleteDirectory = deleteDirectory ?? _delete;
  final Future<Directory> Function() _temporaryDirectory;
  final Future<void> Function(Directory) _deleteDirectory;
  // Failed deletions stay owned by this shared adapter even if the recorder
  // is disposed. The next recording retries them before creating plaintext.
  final Set<String> _cleanupPending = {};
  Set<String> get pendingCleanup => Set.unmodifiable(_cleanupPending);
  static Future<void> _delete(Directory directory) async {
    if (await directory.exists()) {
      await directory.delete(recursive: true);
    }
  }

  @override
  Future<String> createDirectory() async =>
      (await (await _temporaryDirectory()).createTemp('asael-capture-')).path;
  @override
  Future<void> deleteDirectory(String directory) async {
    _cleanupPending.add(directory);
    await _deleteDirectory(Directory(directory));
    _cleanupPending.remove(directory);
  }

  @override
  Future<void> retryCleanup() async {
    Object? failure;
    for (final directory in _cleanupPending.toList()) {
      try {
        await deleteDirectory(directory);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure != null) {
      throw failure;
    }
  }

  @override
  Future<CaptureAttachment> readOriginal(String directory, String path) async {
    final file = File(path);
    if (file.parent.path != directory) {
      throw const FormatException(
        'The microphone returned a different recording.',
      );
    }
    for (var attempt = 0; attempt < 20; attempt++) {
      final count = await file.length();
      if (count > captureAttachmentMaxBytes) {
        throw const FormatException('Record a shorter audio note up to 5 MB.');
      }
      if (count > 44) {
        final bytes = await file.readAsBytes();
        if (bytes.length == count &&
            String.fromCharCodes(bytes.take(4)) == 'RIFF' &&
            String.fromCharCodes(bytes.sublist(8, 12)) == 'WAVE' &&
            ByteData.sublistView(bytes).getUint32(4, Endian.little) + 8 ==
                count) {
          return CaptureAttachment(
            name: 'audio-note.wav',
            bytes: bytes,
            contentType: 'audio/wav',
          );
        }
        bytes.fillRange(0, bytes.length, 0);
      }
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    throw const FormatException(
      'The microphone did not return a complete WAV recording.',
    );
  }
}

final _nativeRecordingFiles = NativeCaptureRecordingFiles();

/// Serial native operations plus an immediately invalidated epoch prevent a
/// delayed permission/encoder/directory reply from restarting a canceled mic.
class NativeCaptureRecorder implements CaptureRecorder {
  NativeCaptureRecorder({
    CaptureRecorderBackend Function()? backendFactory,
    CaptureRecordingFiles? files,
  }) : _backendFactory = backendFactory ?? _RecordBackend.new,
       _files = files ?? _nativeRecordingFiles;
  final CaptureRecorderBackend Function() _backendFactory;
  final CaptureRecordingFiles _files;
  CaptureRecorderBackend? _recorder;
  StreamSubscription<bool>? _states;
  final _changes = StreamController<bool>.broadcast();
  bool _disposed = false;
  int _epoch = 0;
  String? _directory;
  Future<void> _barrier = Future.value();
  CaptureRecorderBackend get _activeRecorder {
    if (_disposed) {
      throw StateError('The Capture recorder is closed.');
    }
    if (_recorder != null) {
      return _recorder!;
    }
    final recorder = _recorder = _backendFactory();
    _states = recorder.recordingChanges.listen(
      (active) {
        if (!_changes.isClosed) _changes.add(active);
      },
      onError: (Object error) {
        if (!_changes.isClosed) _changes.addError(error);
      },
    );
    return recorder;
  }

  Future<T> _serial<T>(Future<T> Function() operation) {
    final result = _barrier.then((_) => operation());
    _barrier = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }

  bool _current(int epoch) => !_disposed && epoch == _epoch;
  @override
  Future<bool> hasPermission() {
    final epoch = _epoch;
    return _serial(() async {
      if (!_current(epoch)) {
        return false;
      }
      final allowed = await _activeRecorder.hasPermission();
      return _current(epoch) && allowed;
    });
  }

  @override
  Future<bool> isRecording() => _recorder?.isRecording() ?? Future.value(false);
  @override
  Stream<bool> get recordingChanges => _changes.stream;
  @override
  Future<void> start() {
    final epoch = ++_epoch;
    return _serial(() async {
      if (!_current(epoch)) {
        return;
      }
      await _cleanup(_directory);
      if (!_current(epoch)) {
        return;
      }
      await _files.retryCleanup();
      if (!_current(epoch)) {
        return;
      }
      final recorder = _activeRecorder;
      final supported = await recorder.supportsWav();
      if (!_current(epoch)) {
        return;
      }
      if (!supported) {
        throw StateError('WAV recording is unavailable.');
      }
      final directory = await _files.createDirectory();
      _directory = directory;
      if (!_current(epoch)) {
        await _cleanup(directory);
        return;
      }
      try {
        await recorder.start('$directory/audio-note.wav');
        if (!_current(epoch)) {
          try {
            await recorder.cancel();
          } finally {
            await _cleanup(directory);
          }
        }
      } catch (_) {
        try {
          await recorder.cancel();
        } finally {
          await _cleanup(directory);
        }
        rethrow;
      }
    });
  }

  @override
  Future<CaptureAttachment?> stop() {
    final epoch = _epoch;
    return _serial(() async {
      if (!_current(epoch)) {
        return null;
      }
      final directory = _directory;
      CaptureAttachment? result;
      try {
        final path = await _recorder?.stop();
        if (!_current(epoch) || path == null || directory == null) {
          return null;
        }
        result = await _files.readOriginal(directory, path);
      } finally {
        try {
          await _cleanup(directory);
        } catch (_) {
          if (result != null) {
            result.bytes.fillRange(0, result.bytes.length, 0);
          }
          rethrow;
        }
      }
      if (!_current(epoch)) {
        result.bytes.fillRange(0, result.bytes.length, 0);
        return null;
      }
      return result;
    });
  }

  Future<void> _cleanup(String? directory) async {
    if (directory == null) {
      return;
    }
    await _files.deleteDirectory(directory);
    if (_directory == directory) {
      _directory = null;
    }
  }

  @override
  Future<void> cancel() {
    ++_epoch;
    return _serial(() async {
      final directory = _directory;
      try {
        await _recorder?.cancel();
      } finally {
        try {
          await _cleanup(directory);
        } finally {
          await _files.retryCleanup();
        }
      }
    });
  }

  @override
  Future<void> dispose() {
    _disposed = true;
    ++_epoch;
    return _serial(() async {
      Object? failure;
      Future<void> attempt(Future<void> Function() action) async {
        try {
          await action();
        } catch (error) {
          failure ??= error;
        }
      }

      await attempt(() async {
        await _recorder?.cancel();
      });
      await attempt(() async {
        await _states?.cancel();
      });
      await attempt(() async {
        await _recorder?.dispose();
      });
      await attempt(() => _cleanup(_directory));
      await attempt(_files.retryCleanup);
      await attempt(() async {
        await _changes.close();
      });
      if (failure != null) {
        throw failure!;
      }
    });
  }
}

enum CaptureRecordingPhase {
  idle,
  requestingPermission,
  starting,
  recording,
  stopping,
  ready,
  unavailable,
}

class CaptureRecordingController extends ChangeNotifier {
  CaptureRecordingController(
    this.capture,
    this.recorder, {
    this.maximumDuration = const Duration(minutes: 2),
    this.recoveryTimeout = const Duration(seconds: 3),
    this.recoveryAttempts = 2,
  }) {
    _captureGeneration = capture.generation;
    _captureAvailable = capture.canWrite;
    capture.addListener(_captureChanged);
    _states = recorder.recordingChanges.listen(
      _recordingChanged,
      onError: (_) {
        microphoneStateKnown = false;
        message = 'Microphone state is unknown. Check the system microphone indicator.';
        _emit();
      },
    );
  }
  final CaptureController capture;
  final CaptureRecorder recorder;
  final Duration maximumDuration;
  final Duration recoveryTimeout;
  final int recoveryAttempts;
  DateTime? _deadline;
  bool deadlineExceeded = false;
  bool microphoneStateKnown = true;
  bool _deadlineRecovery = false;
  CaptureRecordingPhase phase = CaptureRecordingPhase.idle;
  CaptureAttachment? attachment;
  String? message;
  bool microphoneActive = false, consent = false;
  bool _disposed = false;
  bool _captureAvailable = false;
  int _generation = 0, _captureGeneration = 0;
  Timer? _limit;
  StreamSubscription<bool>? _states;
  bool get busy => const {
    CaptureRecordingPhase.requestingPermission,
    CaptureRecordingPhase.starting,
    CaptureRecordingPhase.stopping,
  }.contains(phase);
  bool get canStart =>
      !_disposed &&
      capture.canWrite &&
      !capture.busy &&
      consent &&
      !busy &&
      !microphoneActive &&
      microphoneStateKnown &&
      !deadlineExceeded;
  void setConsent(bool value) {
    if (!busy && !microphoneActive) {
      consent = value;
      _emit();
    }
  }

  void _captureChanged() {
    if (_captureGeneration == capture.generation &&
        capture.canWrite == _captureAvailable) {
      return;
    }
    _captureAvailable = capture.canWrite;
    _captureGeneration = capture.generation;
    _generation++;
    _limit?.cancel();
    _clearAttachment();
    consent = false;
    phase = CaptureRecordingPhase.unavailable;
    message = 'Capture access changed. The recording draft was cleared.';
    unawaited(_stopForScopeChange());
    _emit();
  }

  Future<void> _stopForScopeChange() async {
    final generation = _generation;
    bool current() => !_disposed && generation == _generation;
    await _recoverMicrophoneStop(current);
    if (!current()) return;
    if (!microphoneStateKnown || microphoneActive) {
      message = 'Microphone stop could not be confirmed. Check the system microphone indicator.';
    }
    _emit();
  }

  Future<void> _recoverMicrophoneStop(bool Function() current) async {
    for (var attempt = 0; attempt < recoveryAttempts; attempt++) {
      if (!current()) return;
      try {
        await recorder.cancel().timeout(recoveryTimeout);
      } catch (_) {}
      if (!current()) return;
      try {
        final active = await recorder.isRecording().timeout(recoveryTimeout);
        if (!current()) return;
        microphoneActive = active;
        microphoneStateKnown = true;
      } catch (_) {
        if (!current()) return;
        microphoneStateKnown = false;
      }
      if (microphoneStateKnown && !microphoneActive) return;
    }
  }

  void _recordingChanged(bool active) {
    if (_disposed) {
      return;
    }
    microphoneActive = active;
    microphoneStateKnown = true;
    if (!active && phase == CaptureRecordingPhase.recording) {
      _limit?.cancel();
      phase = CaptureRecordingPhase.unavailable;
      message = 'The microphone stopped. Start a new recording; no audio note was accepted.';
      unawaited(recorder.cancel().catchError((Object _) {}));
    }
    _emit();
  }

  Future<void> start() async {
    if (!canStart) {
      return;
    }
    final generation = ++_generation;
    _clearAttachment();
    phase = CaptureRecordingPhase.requestingPermission;
    message = null;
    _emit();
    bool current() =>
        !_disposed && generation == _generation && capture.canWrite;
    try {
      final allowed = await recorder.hasPermission();
      if (!current()) {
        return;
      }
      if (!allowed) {
        phase = CaptureRecordingPhase.unavailable;
        message = 'Microphone permission was not granted. Allow access in system settings, then try again.';
        return;
      }
      phase = CaptureRecordingPhase.starting;
      _emit();
      deadlineExceeded = false;
      _deadline = DateTime.now().add(maximumDuration);
      _scheduleDeadline();
      await recorder.start();
      if (!current()) {
        await recorder.cancel();
        return;
      }
      final active = await recorder.isRecording();
      if (!current()) {
        await recorder.cancel();
        return;
      }
      microphoneActive = active;
      if (!active) {
        throw StateError('The microphone did not start.');
      }
      phase = CaptureRecordingPhase.recording;
      _scheduleDeadline();
    } catch (_) {
      if (current()) {
        phase = CaptureRecordingPhase.unavailable;
        message = 'The microphone could not start. Check the selected input and try again.';
      }
      try {
        await recorder.cancel();
      } catch (_) {
        if (current()) {
          microphoneStateKnown = false;
          message = 'Microphone stop could not be confirmed. Check the system microphone indicator.';
        }
      }
    } finally {
      if (current()) _emit();
    }
  }

  Future<void> stop() async {
    if (_disposed || !capture.available || busy || !microphoneActive) {
      return;
    }
    if (deadlineExceeded) {
      await _enforceDeadline();
      return;
    }
    final generation = ++_generation;
    phase = CaptureRecordingPhase.stopping;
    message = null;
    _emit();
    bool current() =>
        !_disposed && generation == _generation && capture.canWrite;
    try {
      final result = await recorder.stop();
      final active = await recorder.isRecording();
      if (!current()) {
        if (result != null) result.bytes.fillRange(0, result.bytes.length, 0);
        return;
      }
      microphoneActive = active;
      microphoneStateKnown = true;
      if (active || result == null) {
        throw StateError('The recording was not finalized.');
      }
      _limit?.cancel();
      _deadline = null;
      attachment = result;
      phase = CaptureRecordingPhase.ready;
      message = 'Microphone stopped. Review the audio note before saving it.';
    } catch (_) {
      if (current()) {
        try {
          microphoneActive = await recorder.isRecording();
          microphoneStateKnown = true;
        } catch (_) {
          microphoneStateKnown = false;
        }
        if (!current()) {
          return;
        }
        phase = microphoneActive || !microphoneStateKnown
            ? CaptureRecordingPhase.recording
            : CaptureRecordingPhase.unavailable;
        message = !microphoneStateKnown
            ? 'Microphone state is unknown. Stop or discard again and check the system microphone indicator.'
            : microphoneActive
            ? 'The microphone is still active. Stop or discard the recording again.'
            : 'The microphone stopped, but its audio could not be finalized. Start a new recording.';
        if (microphoneActive || !microphoneStateKnown) {
          _scheduleDeadline();
        } else {
          _limit?.cancel();
          _deadline = null;
        }
      }
    } finally {
      if (current()) _emit();
    }
  }

  void _scheduleDeadline() {
    _limit?.cancel();
    final deadline = _deadline;
    if (_disposed || deadline == null) {
      return;
    }
    final remaining = deadline.difference(DateTime.now());
    _limit = Timer(
      remaining.isNegative ? Duration.zero : remaining,
      () => unawaited(_enforceDeadline()),
    );
  }

  Future<void> _enforceDeadline() async {
    if (_disposed || _deadlineRecovery || !capture.available) {
      return;
    }
    _deadlineRecovery = true;
    deadlineExceeded = true;
    final generation = ++_generation;
    _limit?.cancel();
    _clearAttachment();
    phase = CaptureRecordingPhase.stopping;
    message = 'Recording reached its time limit. Stopping the microphone…';
    _emit();
    try {
      await _recoverMicrophoneStop(
        () => !_disposed && generation == _generation,
      );
      if (_disposed || generation != _generation) {
        return;
      }
      phase = CaptureRecordingPhase.unavailable;
      message = !microphoneStateKnown
          ? 'The recording limit was reached, but microphone stop is unconfirmed. Check the system microphone indicator and revoke microphone access if needed.'
          : microphoneActive
          ? 'The recording limit was reached, but the microphone is still active. Stop or discard again; check system microphone controls.'
          : 'The microphone stopped at the recording limit. The unfinished audio was discarded.';
    } finally {
      _deadlineRecovery = false;
      _emit();
    }
  }

  Future<void> discard() async {
    if (_disposed || busy) {
      return;
    }
    final generation = ++_generation;
    phase = CaptureRecordingPhase.stopping;
    _clearAttachment();
    _emit();
    await _recoverMicrophoneStop(() => !_disposed && generation == _generation);
    if (_disposed || generation != _generation) return;
    if (microphoneStateKnown && !microphoneActive) {
      _limit?.cancel();
      deadlineExceeded = false;
      _deadline = null;
    }
    phase = !microphoneStateKnown
        ? CaptureRecordingPhase.unavailable
        : microphoneActive
        ? CaptureRecordingPhase.recording
        : CaptureRecordingPhase.idle;
    message = !microphoneStateKnown
        ? 'Microphone stop could not be confirmed. Check the system microphone indicator.'
        : microphoneActive
        ? 'The microphone is still active. Try stopping again.'
        : 'Recording discarded. Nothing was uploaded.';
    if ((microphoneActive || !microphoneStateKnown) && !deadlineExceeded) {
      _scheduleDeadline();
    }
    _emit();
  }

  CaptureAttachment? takeAttachment() {
    if (phase != CaptureRecordingPhase.ready || !capture.canWrite) {
      return null;
    }
    final value = attachment;
    attachment = null;
    phase = CaptureRecordingPhase.idle;
    message = 'Audio attached. Save the capture when you are ready.';
    _emit();
    return value;
  }

  void _clearAttachment() {
    attachment?.bytes.fillRange(0, attachment!.bytes.length, 0);
    attachment = null;
  }

  void _emit() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _limit?.cancel();
    _clearAttachment();
    capture.removeListener(_captureChanged);
    unawaited(_states?.cancel());
    unawaited(recorder.dispose().catchError((Object _) {}));
    super.dispose();
  }
}
