import 'dart:async';
import 'dart:ffi';
import 'dart:io';

import 'package:ffi/ffi.dart';

// flock belongs to each open file description, so unlike process-wide fcntl
// locks it also serializes two Flutter engines inside the same macOS process.
// The kernel releases it on process death; a NativeFinalizer closes the stream
// if an engine exits before its asynchronous transaction reaches finally.
final _libc = Platform.isAndroid
    ? DynamicLibrary.open('libc.so')
    : DynamicLibrary.process();
final _fopen = _libc
    .lookupFunction<
      Pointer<Void> Function(Pointer<Utf8>, Pointer<Utf8>),
      Pointer<Void> Function(Pointer<Utf8>, Pointer<Utf8>)
    >('fopen');
final _fileno = _libc
    .lookupFunction<Int32 Function(Pointer<Void>), int Function(Pointer<Void>)>(
      'fileno',
    );
final _flock = _libc
    .lookupFunction<Int32 Function(Int32, Int32), int Function(int, int)>(
      'flock',
    );
final _fclose = _libc
    .lookupFunction<Int32 Function(Pointer<Void>), int Function(Pointer<Void>)>(
      'fclose',
    );
final _closeFinalizer = NativeFinalizer(_libc.lookup('fclose').cast());

class OperationFileLock implements Finalizable {
  OperationFileLock._(this._stream) {
    _closeFinalizer.attach(this, _stream, detach: this);
  }
  final Pointer<Void> _stream;
  bool _closed = false;

  static Future<OperationFileLock> acquire(
    String path, {
    Duration waitLimit = const Duration(seconds: 120),
  }) async {
    if (!(Platform.isAndroid ||
        Platform.isMacOS ||
        Platform.isIOS ||
        Platform.isLinux)) {
      throw UnsupportedError('Durable operation locking is unavailable.');
    }
    final encoded = path.toNativeUtf8();
    final mode = 'a+'.toNativeUtf8();
    Pointer<Void> stream;
    try {
      stream = _fopen(encoded, mode);
    } finally {
      calloc.free(encoded);
      calloc.free(mode);
    }
    if (stream == nullptr) {
      throw const FileSystemException('Pending work could not be locked.');
    }
    final lease = OperationFileLock._(stream);
    final elapsed = Stopwatch()..start();
    try {
      while (_flock(_fileno(stream), 2 | 4) != 0) {
        // LOCK_EX | LOCK_NB
        if (elapsed.elapsed >= waitLimit) {
          throw TimeoutException(
            'Pending work is still being updated in another window.',
            waitLimit,
          );
        }
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
      return lease;
    } catch (_) {
      lease.release();
      rethrow;
    }
  }

  void release() {
    if (_closed) return;
    _closed = true;
    _closeFinalizer.detach(this);
    // Closing this descriptor releases only this holder's kernel lease.
    _fclose(_stream);
  }
}
