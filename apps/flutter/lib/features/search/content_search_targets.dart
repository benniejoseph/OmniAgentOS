import '../companion/companion_models.dart';

enum ContentSearchProvider {
  conversations('Conversations'),
  work('Work'),
  memory('Private memory'),
  library('Library');

  const ContentSearchProvider(this.label);
  final String label;
}

/// Search links are data, never arbitrary routes or browser URLs.
class ContentSearchTarget {
  const ContentSearchTarget(this.provider, this.id, {this.taskId});
  final ContentSearchProvider provider;
  final String id;
  final String? taskId;

  static bool validId(String value, {int maximum = 300}) =>
      value.isNotEmpty &&
      value.length <= maximum &&
      value.trim() == value &&
      !RegExp(r'[\\\x00-\x20\x7f]').hasMatch(value) &&
      !value.split('/').any((part) => part == '.' || part == '..');

  static ContentSearchTarget parse(String href) {
    final uri = Uri.tryParse(href);
    if (href.length > 1600 ||
        !href.startsWith('/app/') ||
        RegExp(r'[\\\x00-\x20\x7f]').hasMatch(href) ||
        RegExp(r'%(?![0-9a-fA-F]{2})').hasMatch(href) ||
        uri == null ||
        uri.hasScheme ||
        uri.hasAuthority ||
        uri.hasFragment ||
        href.split('?').first != uri.path ||
        uri.queryParametersAll.values.any((values) => values.length != 1)) {
      throw const FormatException('This search link is not supported.');
    }
    final query = uri.queryParameters;
    bool keys(Set<String> required, [Set<String> optional = const {}]) =>
        required.every(query.containsKey) &&
        query.keys.every(
          (key) => required.contains(key) || optional.contains(key),
        );
    String id(String key, {int maximum = 300}) {
      final value = query[key];
      if (value == null || !validId(value, maximum: maximum)) {
        throw const FormatException('This search identity is invalid.');
      }
      return value;
    }

    switch (uri.path) {
      case '/app/command':
        if (keys({'thread'}) && companionThreadId(query['thread']) != null) {
          return ContentSearchTarget(
            ContentSearchProvider.conversations,
            query['thread']!,
          );
        }
      case '/app/projects':
        if (keys({'project', 'fromSearch'}, {'task'}) &&
            query['fromSearch'] == '1') {
          return ContentSearchTarget(
            ContentSearchProvider.work,
            id('project'),
            taskId: query.containsKey('task') ? id('task') : null,
          );
        }
      case '/app/memory':
        if (keys({'memory'})) {
          return ContentSearchTarget(
            ContentSearchProvider.memory,
            id('memory', maximum: 240),
          );
        }
      case '/app/capture':
        if (keys({'libraryItem'})) {
          final value = id('libraryItem', maximum: 320);
          if (RegExp(
            r'^library:(capture_asset|capture_recording|capture_transcript|project_artifact|source_item):.+$',
          ).hasMatch(value)) {
            return ContentSearchTarget(ContentSearchProvider.library, value);
          }
        }
    }
    throw const FormatException('This search link is not supported.');
  }

  String get location => switch (provider) {
    ContentSearchProvider.conversations =>
      '/talk?${Uri(queryParameters: {'thread': id}).query}',
    ContentSearchProvider.work =>
      '/projects/${Uri.encodeComponent(id)}?${Uri(queryParameters: {'workItemId': ?taskId, 'fromSearch': '1'}).query}',
    ContentSearchProvider.memory =>
      '/knowledge?${Uri(queryParameters: {'memory': id, 'fromSearch': '1'}).query}',
    ContentSearchProvider.library =>
      '/capture?${Uri(queryParameters: {'libraryItem': id}).query}',
  };
}

/// Accept only canonical native search routes, decoding each identity once.
bool isNativeContentSearchLocation(String location) {
  if (location == '/search') return true;
  final uri = Uri.tryParse(location);
  if (uri == null || uri.hasScheme || uri.hasAuthority || uri.hasFragment) {
    return false;
  }
  try {
    if (uri.queryParametersAll.values.any((values) => values.length != 1)) {
      return false;
    }
    final query = uri.queryParameters;
    ContentSearchTarget? target;
    if (uri.path.startsWith('/projects/') &&
        query['fromSearch'] == '1' &&
        query.keys.every({'workItemId', 'fromSearch'}.contains)) {
      final id = Uri.decodeComponent(uri.path.substring('/projects/'.length));
      final task = query['workItemId'];
      if (ContentSearchTarget.validId(id) &&
          (task == null || ContentSearchTarget.validId(task))) {
        target = ContentSearchTarget(
          ContentSearchProvider.work,
          id,
          taskId: task,
        );
      }
    } else if (uri.path == '/knowledge' &&
        query.length == 2 &&
        query['fromSearch'] == '1' &&
        query.containsKey('memory')) {
      target = ContentSearchTarget.parse(
        '/app/memory?${Uri(queryParameters: {'memory': query['memory']!}).query}',
      );
    } else if (uri.path == '/capture' &&
        query.length == 1 &&
        query.containsKey('libraryItem')) {
      target = ContentSearchTarget.parse('/app/capture?${uri.query}');
    }
    return target?.location == location;
  } on FormatException {
    return false;
  } on ArgumentError {
    return false;
  }
}
