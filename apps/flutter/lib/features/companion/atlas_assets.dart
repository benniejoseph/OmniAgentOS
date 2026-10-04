import 'dart:convert';
import 'dart:ui' as ui;

import 'package:cryptography/cryptography.dart';
import 'package:flutter/services.dart';

const atlasAssetDirectory = 'assets/companion/atlas-v1';
const atlasStates = {
  'available',
  'listening',
  'responding',
  'working',
  'needs_you',
  'blocked',
  'completed',
  'paused',
};

Map<String, dynamic> _record(Object? value, Set<String> keys) {
  if (value is! Map ||
      value.length != keys.length ||
      !value.keys.every(keys.contains)) {
    throw const FormatException('ATLAS asset metadata is unavailable.');
  }
  return Map<String, dynamic>.from(value);
}

class AtlasThemeAssets {
  const AtlasThemeAssets(
    this.poster,
    this.sprite,
    this.posterHash,
    this.spriteHash,
  );
  final String poster, sprite, posterHash, spriteHash;

  factory AtlasThemeAssets.parse(Object? value, String state, String theme) {
    final row = _record(value, {
      'poster',
      'sprite',
      'posterSha256',
      'spriteSha256',
    });
    final posterHash = row['posterSha256'], spriteHash = row['spriteSha256'];
    final hash = RegExp(r'^[a-f0-9]{64}$');
    if (row['poster'] != '$state-$theme-poster.webp' ||
        row['sprite'] != '$state-$theme-sprite.webp' ||
        posterHash is! String ||
        !hash.hasMatch(posterHash) ||
        spriteHash is! String ||
        !hash.hasMatch(spriteHash)) {
      throw const FormatException('ATLAS asset identity is unavailable.');
    }
    return AtlasThemeAssets(
      row['poster'] as String,
      row['sprite'] as String,
      posterHash,
      spriteHash,
    );
  }
}

class AtlasClip {
  const AtlasClip(this.durationMs, this.frameCount, this.light, this.dark);
  final int durationMs, frameCount;
  final AtlasThemeAssets light, dark;
  int get rows => (frameCount + 3) ~/ 4;

  factory AtlasClip.parse(Object? value, String state) {
    final row = _record(value, {'durationMs', 'frameCount', 'light', 'dark'});
    final duration = row['durationMs'], frames = row['frameCount'];
    if (duration is! int ||
        duration < 1 ||
        duration > 1200 ||
        frames is! int ||
        frames < 2 ||
        frames > 25 ||
        frames != (duration + 49) ~/ 50 + 1) {
      throw const FormatException('ATLAS clip bounds are unavailable.');
    }
    return AtlasClip(
      duration,
      frames,
      AtlasThemeAssets.parse(row['light'], state, 'light'),
      AtlasThemeAssets.parse(row['dark'], state, 'dark'),
    );
  }
}

class AtlasManifest {
  const AtlasManifest(this.creativeRevision, this.states);
  final String creativeRevision;
  final Map<String, AtlasClip> states;

  factory AtlasManifest.parse(Object? value) {
    final row = _record(value, {
      'schemaVersion',
      'creativeRevision',
      'frameSize',
      'fps',
      'columns',
      'states',
    });
    final revision = row['creativeRevision'];
    if (row['schemaVersion'] is! int ||
        row['schemaVersion'] != 1 ||
        row['frameSize'] is! int ||
        row['frameSize'] != 256 ||
        row['fps'] is! int ||
        row['fps'] != 20 ||
        row['columns'] is! int ||
        row['columns'] != 4 ||
        revision is! String ||
        revision.trim().isEmpty ||
        revision != revision.trim() ||
        revision.length > 160 ||
        RegExp(r'[\u0000-\u001f\u007f]').hasMatch(revision)) {
      throw const FormatException('ATLAS delivery format is unavailable.');
    }
    final states = _record(row['states'], atlasStates);
    return AtlasManifest(
      revision,
      Map.unmodifiable({
        for (final state in atlasStates)
          state: AtlasClip.parse(states[state], state),
      }),
    );
  }
}

/// Bundled, hash-checked assets only. No network, animation codec, or texture cache.
class AtlasAssets {
  static final _manifests = Expando<Future<AtlasManifest?>>();

  static Future<AtlasManifest?> manifest(AssetBundle bundle) =>
      _manifests[bundle] ??= _readManifest(bundle);

  static Future<AtlasManifest?> _readManifest(AssetBundle bundle) async {
    try {
      final data = await bundle.load('$atlasAssetDirectory/manifest.json');
      if (data.lengthInBytes > 16 * 1024) {
        return null;
      }
      return AtlasManifest.parse(
        jsonDecode(
          utf8.decode(
            data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
          ),
        ),
      );
    } catch (_) {
      return null;
    }
  }

  static Future<ui.Image> texture(
    AssetBundle bundle,
    AtlasClip clip, {
    required bool dark,
    required bool sprite,
  }) async {
    final variant = dark ? clip.dark : clip.light;
    final data = await bundle.load(
      '$atlasAssetDirectory/${sprite ? variant.sprite : variant.poster}',
    );
    if (data.lengthInBytes == 0 || data.lengthInBytes > 8 * 1024 * 1024) {
      throw const FormatException('ATLAS image exceeds its bounded delivery.');
    }
    final bytes = data.buffer.asUint8List(
      data.offsetInBytes,
      data.lengthInBytes,
    );
    final digest = await Sha256().hash(bytes);
    final hash = digest.bytes
        .map((value) => value.toRadixString(16).padLeft(2, '0'))
        .join();
    if (hash != (sprite ? variant.spriteHash : variant.posterHash)) {
      throw const FormatException(
        'ATLAS image identity could not be verified.',
      );
    }
    final buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
    ui.ImageDescriptor? descriptor;
    ui.Codec? codec;
    try {
      descriptor = await ui.ImageDescriptor.encoded(buffer);
      if (descriptor.width != (sprite ? 1024 : 256) ||
          descriptor.height != (sprite ? clip.rows * 256 : 256)) {
        throw const FormatException('ATLAS image geometry is unavailable.');
      }
      codec = await descriptor.instantiateCodec();
      if (codec.frameCount != 1) {
        throw const FormatException('ATLAS textures must be static images.');
      }
      return (await codec.getNextFrame()).image;
    } finally {
      codec?.dispose();
      descriptor?.dispose();
      buffer.dispose();
    }
  }
}
