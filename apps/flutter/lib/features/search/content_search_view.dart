import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../app/platform/macos_presentation.dart';
import '../../core/network/native_workspace_access.dart';
import '../capture/library_view.dart';
import '../knowledge/knowledge.dart' show KnowledgeController, MemoryRecord;
import '../knowledge/knowledge_providers.dart';
import '../knowledge/knowledge_read_widgets.dart';
import '../projects/projects.dart' show Project;
import 'content_search_contracts.dart';
import 'content_search_controller.dart';
import 'content_search_providers.dart';
import 'content_search_repository.dart';

class NativeContentSearchPage extends StatelessWidget {
  const NativeContentSearchPage({super.key});
  @override
  Widget build(BuildContext context) => _SearchPrivateSurface(
    builder: (_, visibility, fence) => Consumer(
      builder: (context, ref, _) {
        final controller = ref.watch(
          contentSearchControllerProvider(visibility),
        );
        fence(() => controller?.invalidate(notify: false));
        return controller == null
            ? const Center(
                child: Text('Search is unavailable for this session.'),
              )
            : ContentSearchView(
                key: ObjectKey(controller),
                controller: controller,
                onOpen: (target) {
                  if (controller.available) context.push(target.location);
                },
              );
      },
    ),
  );
}

class ContentSearchView extends StatefulWidget {
  const ContentSearchView({
    super.key,
    required this.controller,
    required this.onOpen,
  });
  final ContentSearchController controller;
  final ValueChanged<ContentSearchTarget> onOpen;
  @override
  State<ContentSearchView> createState() => _ContentSearchViewState();
}

class _ContentSearchViewState extends State<ContentSearchView>
    with WidgetsBindingObserver {
  final _query = TextEditingController();
  final _focus = FocusNode(debugLabel: 'Search workspace content');
  String? _formError;
  ContentSearchController get c => widget.controller;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _query.text = c.query;
    c.addListener(_changed);
  }

  void _changed() {
    if (!c.available) {
      _query.clear();
      _formError = null;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) =>
      c.setVisible(state == AppLifecycleState.resumed);
  @override
  void didUpdateWidget(covariant ContentSearchView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, c)) {
      oldWidget.controller.removeListener(_changed);
      _query.text = c.query;
      _formError = null;
      c.addListener(_changed);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    c.removeListener(_changed);
    _query.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _focusQuery() {
    _focus.requestFocus();
    _query.selection = TextSelection(
      baseOffset: 0,
      extentOffset: _query.text.length,
    );
  }

  void _submit() {
    try {
      final query = contentSearchQuery(_query.text);
      setState(() => _formError = null);
      unawaited(c.submit(query));
    } on FormatException catch (error) {
      setState(() => _formError = error.message);
      _focus.requestFocus();
    }
  }

  void _clear() {
    _query.clear();
    c.edit();
    setState(() => _formError = null);
    _focus.requestFocus();
  }

  @override
  Widget build(BuildContext context) {
    final body = CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.keyK, meta: true): _focusQuery,
        const SingleActivator(LogicalKeyboardKey.keyK, control: true):
            _focusQuery,
        const SingleActivator(LogicalKeyboardKey.escape): _clear,
      },
      child: FocusScope(
        autofocus: true,
        child: FocusTraversalGroup(
          child: ListenableBuilder(
            listenable: c,
            builder: (context, _) {
              final scheme = Theme.of(context).colorScheme;
              return Align(
                alignment: Alignment.topCenter,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 1000),
                  child: ListView(
                    padding: const EdgeInsets.all(20),
                    children: [
                      if (!usesMacosPresentation()) ...[
                        Text(
                          'Search your workspace',
                          style: Theme.of(context).textTheme.headlineSmall,
                        ),
                        const SizedBox(height: 8),
                        const Text(
                          'Find conversations, work, private memory and saved sources.',
                        ),
                        const SizedBox(height: 20),
                      ],
                      TextField(
                        key: const Key('content-search-query'),
                        controller: _query,
                        focusNode: _focus,
                        autofocus: true,
                        maxLength: 240,
                        textInputAction: TextInputAction.search,
                        onChanged: (_) {
                          c.edit();
                          if (_formError != null) {
                            setState(() => _formError = null);
                          }
                        },
                        onSubmitted: (_) => _submit(),
                        decoration: InputDecoration(
                          labelText: 'Search workspace content',
                          hintText: 'Enter a name, topic or phrase',
                          errorText: _formError,
                          prefixIcon: const Icon(Icons.search_rounded),
                          suffixIcon: IconButton(
                            tooltip: 'Clear search',
                            onPressed: _clear,
                            icon: const Icon(Icons.close_rounded),
                          ),
                        ),
                      ),
                      const SizedBox(height: 8),
                      Row(
                        children: [
                          FilledButton.icon(
                            onPressed: _submit,
                            icon: const Icon(Icons.search_rounded),
                            label: const Text('Search'),
                          ),
                          const SizedBox(width: 16),
                          Expanded(
                            child: Text(
                              'Press Enter to search. Results are checked live.',
                              style: TextStyle(color: scheme.onSurfaceVariant),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 24),
                      if (c.loading)
                        Semantics(
                          label: 'Searching workspace content',
                          liveRegion: true,
                          child: const LinearProgressIndicator(),
                        ),
                      if (c.error != null) ...[
                        Semantics(
                          liveRegion: true,
                          child: Text(
                            c.error!,
                            style: TextStyle(color: scheme.error),
                          ),
                        ),
                        const SizedBox(height: 8),
                        Align(
                          alignment: Alignment.centerLeft,
                          child: OutlinedButton(
                            onPressed: _submit,
                            child: const Text('Retry search'),
                          ),
                        ),
                      ],
                      if (c.query.isEmpty && c.error == null)
                        const Padding(
                          padding: EdgeInsets.symmetric(vertical: 24),
                          child: Text(
                            'Search the content available to your current account. Each source explains what it covers.',
                          ),
                        ),
                      if (!c.loading && c.groups.isNotEmpty) ...[
                        Semantics(
                          liveRegion: true,
                          child: Text(
                            'Results for “${c.query}”',
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          'Live results may change between pages. Open a result to check its current access.',
                          style: TextStyle(color: scheme.onSurfaceVariant),
                        ),
                        const SizedBox(height: 16),
                        for (final provider in ContentSearchProvider.values)
                          if (c.groups[provider] case final lane?)
                            _group(context, provider, lane),
                      ],
                    ],
                  ),
                ),
              );
            },
          ),
        ),
      ),
    );
    return usesMacosPresentation()
        ? MacosPageScaffold(
            title: 'Search',
            description:
                'Find conversations, work, private memory and saved sources.',
            icon: Icons.search_rounded,
            body: body,
          )
        : body;
  }

  Widget _group(
    BuildContext context,
    ContentSearchProvider provider,
    ContentSearchLane lane,
  ) {
    final group = lane.group, scheme = Theme.of(context).colorScheme;
    final canRead = c.available && !lane.loading;
    return Card(
      margin: const EdgeInsets.only(bottom: 16),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(_icon(provider), size: 20),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    provider.label,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                if (group.ready)
                  Text(
                    '${group.items.length} shown',
                    style: TextStyle(color: scheme.onSurfaceVariant),
                  ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              group.coverage,
              style: TextStyle(color: scheme.onSurfaceVariant),
            ),
            const SizedBox(height: 12),
            if (!group.ready)
              const Text(
                'This source is unavailable. Its results are unknown.',
              ),
            if (group.ready && group.items.isEmpty)
              Text(
                'No matching ${provider.label.toLowerCase()} in this source.',
              ),
            for (final item in group.items)
              ListTile(
                key: ValueKey((provider, item.id)),
                contentPadding: EdgeInsets.zero,
                title: Text(item.title),
                subtitle: Text(item.detail),
                trailing: const Icon(Icons.chevron_right_rounded),
                onTap: c.available ? () => widget.onOpen(item.target) : null,
              ),
            if (lane.loading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: LinearProgressIndicator(),
              ),
            if (lane.error != null)
              Semantics(
                liveRegion: true,
                child: Text(lane.error!, style: TextStyle(color: scheme.error)),
              ),
            if (lane.atLimit)
              const Text(
                'Showing the first 100 results in this source. Refine your search for more specific results.',
              ),
            if (!group.ready ||
                lane.error != null ||
                group.nextCursor != null && !lane.atLimit) ...[
              const SizedBox(height: 10),
              OutlinedButton(
                onPressed: canRead
                    ? () => c.loadProvider(
                        provider,
                        restart: !group.ready || lane.restartRequired,
                      )
                    : null,
                child: Text(
                  lane.restartRequired
                      ? 'Restart ${provider.label}'
                      : !group.ready || lane.error != null
                      ? 'Retry ${provider.label}'
                      : 'More ${provider.label}',
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

IconData _icon(ContentSearchProvider provider) => switch (provider) {
  ContentSearchProvider.conversations => Icons.chat_bubble_outline_rounded,
  ContentSearchProvider.work => Icons.folder_copy_outlined,
  ContentSearchProvider.memory => Icons.account_tree_outlined,
  ContentSearchProvider.library => Icons.library_books_outlined,
};

class NativeSearchMemoryPage extends StatelessWidget {
  const NativeSearchMemoryPage({super.key, required this.id});
  final String id;
  @override
  Widget build(BuildContext context) => _SearchPrivateSurface(
    builder: (_, visibility, fence) => Consumer(
      builder: (context, ref, _) {
        final search = ref.watch(contentSearchRepositoryProvider);
        final controller = ref.watch(
          knowledgeControllerProvider.select((value) => value),
        );
        return search == null
            ? const Center(child: Text('Search access is unavailable.'))
            : _SearchMemoryInspector(
                key: ValueKey((search, controller, id)),
                id: id,
                repository: search,
                controller: controller,
                fence: fence,
              );
      },
    ),
  );
}

class _SearchMemoryInspector extends StatefulWidget {
  const _SearchMemoryInspector({
    super.key,
    required this.id,
    required this.repository,
    required this.controller,
    required this.fence,
  });
  final String id;
  final ApiContentSearchRepository repository;
  final KnowledgeController controller;
  final void Function(VoidCallback) fence;
  @override
  State<_SearchMemoryInspector> createState() => _SearchMemoryInspectorState();
}

class _SearchMemoryInspectorState extends State<_SearchMemoryInspector> {
  CancelToken? _read;
  @override
  void initState() {
    super.initState();
    widget.fence(() => _read?.cancel('The memory was hidden.'));
  }

  Future<MemoryRecord> _inspect(String id) {
    _read?.cancel('The exact memory read changed.');
    return widget.repository.memory(id, _read = CancelToken());
  }

  @override
  void dispose() {
    _read?.cancel('The memory was closed.');
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Private memory')),
    body: KnowledgeMemoryInspector(
      controller: widget.controller,
      memoryId: widget.id,
      exactRead: _inspect,
      readOnly: true,
      onOpenWorkspace: () {
        if (widget.repository.current && _read?.isCancelled != true) {
          context.push(
            '/knowledge?${Uri(queryParameters: {'memory': widget.id}).query}',
          );
        }
      },
      onClose: () => context.canPop() ? context.pop() : context.go('/search'),
    ),
  );
}

class NativeSearchWorkPage extends StatelessWidget {
  const NativeSearchWorkPage({super.key, required this.id, this.taskId});
  final String id;
  final String? taskId;
  @override
  Widget build(BuildContext context) => _SearchPrivateSurface(
    builder: (_, visibility, fence) => Consumer(
      builder: (context, ref, _) {
        final repository = ref.watch(contentSearchRepositoryProvider);
        return repository == null
            ? const Center(child: Text('Search access is unavailable.'))
            : _SearchWorkInspector(
                key: ValueKey((repository, id, taskId)),
                id: id,
                taskId: taskId,
                repository: repository,
                fence: fence,
              );
      },
    ),
  );
}

class _SearchWorkInspector extends StatefulWidget {
  const _SearchWorkInspector({
    super.key,
    required this.id,
    this.taskId,
    required this.repository,
    required this.fence,
  });
  final String id;
  final String? taskId;
  final ApiContentSearchRepository repository;
  final void Function(VoidCallback) fence;
  @override
  State<_SearchWorkInspector> createState() => _SearchWorkInspectorState();
}

class _SearchWorkInspectorState extends State<_SearchWorkInspector> {
  CancelToken? _read;
  int _generation = 0;
  Project? _project;
  bool _loading = true, _closed = false;
  String? _error;
  @override
  void initState() {
    super.initState();
    widget.fence(_fence);
    unawaited(_load());
  }

  void _fence() {
    _closed = true;
    _generation++;
    _read?.cancel('The Work result was hidden.');
    _project = null;
    _error = null;
  }

  Future<void> _load() async {
    if (_closed || !widget.repository.current || !mounted) return;
    final generation = ++_generation;
    _read?.cancel('The Work read changed.');
    final token = _read = CancelToken();
    setState(() {
      _project = null;
      _error = null;
      _loading = true;
    });
    bool current() =>
        mounted &&
        !_closed &&
        generation == _generation &&
        !token.isCancelled &&
        widget.repository.current;
    try {
      final project = await widget.repository.work(
        widget.id,
        widget.taskId,
        token,
      );
      if (current()) setState(() => _project = project);
    } catch (_) {
      if (current()) {
        setState(
          () => _error = 'This Work result is unavailable or no longer accessible. Retry to check its current state.',
        );
      }
    } finally {
      if (current()) setState(() => _loading = false);
    }
  }

  @override
  void dispose() {
    _fence();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final project = _project;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Work search result'),
        actions: [
          IconButton(
            tooltip: 'Refresh exact Work result',
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          if (_loading) const LinearProgressIndicator(),
          if (_error != null) ...[
            Text(_error!),
            const SizedBox(height: 12),
            Align(
              alignment: Alignment.centerLeft,
              child: OutlinedButton(
                onPressed: _load,
                child: const Text('Retry exact Work read'),
              ),
            ),
          ],
          if (project != null) ...[
            Text(
              project.title,
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            const SizedBox(height: 8),
            SelectableText(project.objective),
            const SizedBox(height: 12),
            Text('${project.status} · ${project.executionStatus}'),
            const SizedBox(height: 16),
            Align(
              alignment: Alignment.centerLeft,
              child: OutlinedButton.icon(
                onPressed: () {
                  if (!_closed &&
                      widget.repository.current &&
                      identical(_project, project)) {
                    context.push(
                      '/projects/${Uri.encodeComponent(project.id)}${widget.taskId == null ? '' : '?${Uri(queryParameters: {'workItemId': widget.taskId!}).query}'}',
                    );
                  }
                },
                icon: const Icon(Icons.folder_open_outlined),
                label: const Text('Open project workspace'),
              ),
            ),
            const SizedBox(height: 20),
            Text(
              'Tasks in this live result',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            if (project.tasks.isEmpty)
              const Text('No tasks are present in this result.'),
            for (final task in project.tasks)
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (task.id == widget.taskId)
                        const Text(
                          'Selected search result',
                          style: TextStyle(fontWeight: FontWeight.bold),
                        ),
                      Text(
                        task.title,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 6),
                      SelectableText(task.detail),
                      const SizedBox(height: 8),
                      Text('${task.status} · ${task.priority}'),
                    ],
                  ),
                ),
              ),
            const SizedBox(height: 20),
            Text(
              'Artifacts in this live result',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            if (project.artifacts.isEmpty)
              const Text('No artifacts are present in this result.'),
            for (final artifact in project.artifacts)
              ExpansionTile(
                key: ValueKey((widget.repository, artifact.id)),
                title: Text(artifact.title),
                subtitle: Text(artifact.status),
                children: [
                  Padding(
                    padding: const EdgeInsets.all(16),
                    child: SelectableText(artifact.content),
                  ),
                ],
              ),
          ],
        ],
      ),
    );
  }
}

class NativeSearchLibraryPage extends StatelessWidget {
  const NativeSearchLibraryPage({super.key, required this.id});
  final String id;
  @override
  Widget build(BuildContext context) => _SearchPrivateSurface(
    builder: (_, visibility, fence) => Consumer(
      builder: (context, ref, _) {
        final controller = ref.watch(
          contentSearchLibraryControllerProvider((visibility, id)),
        );
        fence(() => controller?.invalidate(notify: false));
        return Scaffold(
          appBar: AppBar(title: const Text('Library')),
          body: controller == null
              ? const Center(
                  child: Text('Library is unavailable for this session.'),
                )
              : LibraryView(
                  key: ObjectKey(controller),
                  controller: controller,
                  initialLibraryItemId: id,
                ),
        );
      },
    ),
  );
}

/// Indexed shell branches stay mounted while hidden. Protected widgets and
/// their per-view reads live below this guard and are discarded together.
class _SearchPrivateSurface extends StatefulWidget {
  const _SearchPrivateSurface({required this.builder});
  final Widget Function(
    NativeWorkspaceAccess,
    Object,
    void Function(VoidCallback),
  )
  builder;
  @override
  State<_SearchPrivateSurface> createState() => _SearchPrivateSurfaceState();
}

class _SearchPrivateSurfaceState extends State<_SearchPrivateSurface>
    with WidgetsBindingObserver {
  bool _foreground = true;
  Object _visibility = Object();
  VoidCallback? _fence;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    _foreground = lifecycle == null || lifecycle == AppLifecycleState.resumed;
  }

  void _close() {
    final close = _fence;
    _fence = null;
    if (close != null) {
      close();
      _visibility = Object();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final next = state == AppLifecycleState.resumed;
    if (next == _foreground) return;
    _close();
    setState(() => _foreground = next);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!_foreground || !TickerMode.valuesOf(context).enabled) {
      _close();
      return const SizedBox.shrink();
    }
    return NativePrivateWorkspace(
      builder: (access) => KeyedSubtree(
        key: ValueKey((access.identity, _visibility)),
        child: widget.builder(access, _visibility, (close) => _fence = close),
      ),
    );
  }
}
