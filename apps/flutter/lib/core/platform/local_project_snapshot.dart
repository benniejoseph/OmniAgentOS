import 'package:flutter/foundation.dart';

@immutable
class LocalProjectSnapshot {
  const LocalProjectSnapshot({
    required this.isRepository,
    required this.branch,
    required this.detached,
    required this.remotes,
    required this.changes,
    required this.files,
    required this.truncated,
  });

  factory LocalProjectSnapshot.fromArguments(Object? value) {
    if (value is! Map ||
        value.length != 7 ||
        value['isRepository'] is! bool ||
        value['branch'] is! String ||
        value['detached'] is! bool ||
        value['truncated'] is! bool ||
        value['files'] is! List ||
        value['changes'] is! List ||
        value['remotes'] is! List) {
      throw const FormatException('The project snapshot is invalid.');
    }
    final files = List<String>.from(value['files'] as List);
    final changes = (value['changes'] as List)
        .map((item) {
          if (item is! Map ||
              item.length != 2 ||
              item['path'] is! String ||
              item['status'] is! String ||
              !validLocalProjectPath(item['path'] as String) ||
              (item['status'] as String).length != 2) {
            throw const FormatException('A project change is invalid.');
          }
          return LocalProjectChange(
            path: item['path'] as String,
            status: item['status'] as String,
          );
        })
        .toList(growable: false);
    final remotes = (value['remotes'] as List)
        .map((item) {
          if (item is! Map ||
              item.length != 2 ||
              item['name'] is! String ||
              item['url'] is! String ||
              (item['name'] as String).length > 120 ||
              (item['url'] as String).length > 500) {
            throw const FormatException('A project remote is invalid.');
          }
          return LocalProjectRemote(
            name: item['name'] as String,
            url: item['url'] as String,
          );
        })
        .toList(growable: false);
    if (files.length > 2000 ||
        changes.length > 2000 ||
        remotes.length > 32 ||
        !files.every(validLocalProjectPath) ||
        (value['branch'] as String).length > 240) {
      throw const FormatException('The project snapshot exceeds its bounds.');
    }
    return LocalProjectSnapshot(
      isRepository: value['isRepository'] as bool,
      branch: value['branch'] as String,
      detached: value['detached'] as bool,
      remotes: List.unmodifiable(remotes),
      changes: List.unmodifiable(changes),
      files: List.unmodifiable(files),
      truncated: value['truncated'] as bool,
    );
  }

  final bool isRepository;
  final String branch;
  final bool detached;
  final List<LocalProjectRemote> remotes;
  final List<LocalProjectChange> changes;
  final List<String> files;
  final bool truncated;

  String get branchLabel => !isRepository
      ? 'Folder'
      : detached
      ? '$branch · detached'
      : branch.isEmpty
      ? 'New repository'
      : branch;
}

@immutable
class LocalProjectChange {
  const LocalProjectChange({required this.path, required this.status});
  final String path;
  final String status;
  String get label => status == '??'
      ? 'New'
      : status.contains('D')
      ? 'Deleted'
      : status.contains('R')
      ? 'Renamed'
      : 'Modified';
}

@immutable
class LocalProjectRemote {
  const LocalProjectRemote({required this.name, required this.url});
  final String name;
  final String url;
}

@immutable
class LocalProjectFile {
  const LocalProjectFile({
    required this.path,
    required this.content,
    required this.truncated,
    required this.binary,
  });
  factory LocalProjectFile.fromArguments(Object? value) {
    if (value is! Map ||
        value.length != 4 ||
        value['path'] is! String ||
        value['content'] is! String ||
        value['truncated'] is! bool ||
        value['binary'] is! bool ||
        !validLocalProjectPath(value['path'] as String) ||
        (value['content'] as String).length > 256 * 1024) {
      throw const FormatException('The project file is invalid.');
    }
    return LocalProjectFile(
      path: value['path'] as String,
      content: value['content'] as String,
      truncated: value['truncated'] as bool,
      binary: value['binary'] as bool,
    );
  }
  final String path;
  final String content;
  final bool truncated;
  final bool binary;
}

bool validLocalProjectPath(String path) =>
    path.isNotEmpty &&
    path.length <= 4096 &&
    !path.startsWith('/') &&
    !path.split('/').any((part) => part == '..' || part == '.git') &&
    !RegExp(r'[\u0000-\u001f\u007f]').hasMatch(path);
