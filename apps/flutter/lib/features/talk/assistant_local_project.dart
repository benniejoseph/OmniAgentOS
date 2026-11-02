import 'package:flutter/material.dart';

import '../../core/platform/local_computer_bridge.dart';
import '../computer_use/local_computer.dart';

class AssistantLocalProjectBar extends StatefulWidget {
  const AssistantLocalProjectBar({
    super.key,
    required this.coordinator,
    required this.workspaceId,
    required this.onChoose,
    required this.onSelect,
    required this.busy,
    this.onOpen,
  });
  final LocalComputerCoordinator coordinator;
  final String? workspaceId;
  final VoidCallback onChoose;
  final ValueChanged<LocalCommandWorkspace> onSelect;
  final bool busy;
  final ValueChanged<LocalCommandWorkspace>? onOpen;
  @override
  State<AssistantLocalProjectBar> createState() =>
      _AssistantLocalProjectBarState();
}

class _AssistantLocalProjectBarState extends State<AssistantLocalProjectBar> {
  Future<LocalProjectSnapshot>? _snapshot;
  @override
  void initState() {
    super.initState();
    _refresh();
  }

  @override
  void didUpdateWidget(AssistantLocalProjectBar oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.workspaceId != widget.workspaceId ||
        oldWidget.coordinator != widget.coordinator ||
        (oldWidget.busy && !widget.busy)) {
      _refresh();
    }
  }

  void _refresh() {
    final id = widget.workspaceId;
    _snapshot = id == null ? null : widget.coordinator.inspectProject(id);
  }

  Future<void> _openPanel(LocalCommandWorkspace selected) async {
    if (widget.onOpen != null) {
      widget.onOpen!(selected);
      return;
    }
    await showDialog<void>(
      context: context,
      builder: (_) => AssistantLocalProjectPanel(
        workspace: selected,
        coordinator: widget.coordinator,
      ),
    );
    if (mounted) setState(_refresh);
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.coordinator,
    builder: (context, _) {
      final folders =
          widget.coordinator.status?.commandWorkspaces ??
          const <LocalCommandWorkspace>[];
      final selected = folders
          .where((folder) => folder.id == widget.workspaceId)
          .firstOrNull;
      return Wrap(
        spacing: 6,
        runSpacing: 4,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          PopupMenuButton<String>(
            tooltip: 'Project folder',
            enabled: !widget.busy,
            onSelected: (id) {
              if (id == 'open') {
                widget.onChoose();
                return;
              }
              final folder = folders
                  .where((folder) => folder.id == id)
                  .firstOrNull;
              if (folder != null) widget.onSelect(folder);
            },
            itemBuilder: (_) => [
              for (final folder in folders)
                PopupMenuItem(
                  value: folder.id,
                  child: ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(
                      folder.id == widget.workspaceId
                          ? Icons.check_rounded
                          : Icons.folder_outlined,
                      size: 18,
                    ),
                    title: Text(folder.name),
                    subtitle: Text(
                      folder.path,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ),
              if (folders.isNotEmpty) const PopupMenuDivider(),
              const PopupMenuItem(value: 'open', child: Text('Open folder…')),
            ],
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.folder_open_outlined, size: 17),
                  const SizedBox(width: 7),
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 220),
                    child: Text(
                      selected?.name ??
                          (widget.workspaceId == null
                              ? 'Open folder'
                              : 'Folder unavailable'),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  const SizedBox(width: 4),
                  const Icon(Icons.expand_more_rounded, size: 15),
                ],
              ),
            ),
          ),
          if (selected != null)
            FutureBuilder<LocalProjectSnapshot>(
              key: ValueKey(widget.workspaceId),
              future: _snapshot,
              builder: (context, value) => TextButton.icon(
                onPressed: () => _openPanel(selected),
                icon: const Icon(Icons.account_tree_outlined, size: 15),
                label: Text(
                  value.hasError
                      ? 'Refresh Git'
                      : value.data == null
                      ? 'Reading Git…'
                      : value.data!.branchLabel,
                ),
              ),
            ),
          if (selected != null)
            TextButton.icon(
              icon: const Icon(Icons.view_sidebar_outlined, size: 16),
              label: const Text('Files & changes'),
              onPressed: () => _openPanel(selected),
            ),
        ],
      );
    },
  );
}

class AssistantLocalProjectPanel extends StatefulWidget {
  const AssistantLocalProjectPanel({
    super.key,
    required this.workspace,
    required this.coordinator,
    this.embedded = false,
    this.busy = false,
    this.onClose,
  }) : assert(!embedded || onClose != null);
  final LocalCommandWorkspace workspace;
  final LocalComputerCoordinator coordinator;
  final bool embedded;
  final bool busy;
  final VoidCallback? onClose;
  @override
  State<AssistantLocalProjectPanel> createState() =>
      _AssistantLocalProjectPanelState();
}

class _AssistantLocalProjectPanelState
    extends State<AssistantLocalProjectPanel> {
  late Future<LocalProjectSnapshot> _snapshot;
  Future<LocalProjectFile>? _file;
  String? _path;
  bool _changes = true;
  @override
  void initState() {
    super.initState();
    _refresh();
  }

  @override
  void didUpdateWidget(AssistantLocalProjectPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.workspace.id != widget.workspace.id ||
        (oldWidget.busy && !widget.busy)) {
      _refresh();
    }
  }

  void _refresh() {
    _snapshot = widget.coordinator.inspectProject(widget.workspace.id);
    _file = null;
    _path = null;
  }

  void _open(String path) => setState(() {
    _path = path;
    _file = widget.coordinator.readProjectFile(
      widget.workspace.id,
      path,
      changes: _changes,
    );
  });
  @override
  Widget build(BuildContext context) => _frame(
    context,
    Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 10, 8, 10),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      widget.workspace.name,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    Text(
                      widget.workspace.path,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
              IconButton(
                tooltip: 'Refresh project',
                onPressed: () => setState(_refresh),
                icon: const Icon(Icons.refresh_rounded),
              ),
              IconButton(
                tooltip: 'Close files and changes',
                onPressed: widget.onClose ?? () => Navigator.pop(context),
                icon: const Icon(Icons.close_rounded),
              ),
            ],
          ),
        ),
        const Divider(height: 1),
        Expanded(
          child: FutureBuilder<LocalProjectSnapshot>(
            future: _snapshot,
            builder: (context, value) {
              if (value.hasError) {
                return _notice(
                  context,
                  'This folder could not be read. Choose it again if it moved or its access changed.',
                );
              }
              final snapshot = value.data;
              if (snapshot == null) {
                return const Center(child: CircularProgressIndicator());
              }
              if (!snapshot.isRepository) {
                return _notice(
                  context,
                  'No Git working tree was detected in this folder. You can still ask Asael to work here.',
                );
              }
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(18, 12, 18, 4),
                    child: Wrap(
                      spacing: 16,
                      runSpacing: 6,
                      children: [
                        Text(
                          snapshot.branchLabel,
                          style: Theme.of(context).textTheme.labelLarge,
                        ),
                        Text(
                          snapshot.changes.isEmpty
                              ? 'Working tree clean'
                              : '${snapshot.changes.length} changed files',
                        ),
                        for (final remote in snapshot.remotes)
                          SelectableText(
                            '${remote.name} · ${remote.url}',
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                        if (snapshot.remotes.isEmpty)
                          const Text('Local repository · no remote configured'),
                        if (snapshot.truncated)
                          const Text('Showing a partial file list'),
                      ],
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 8,
                    ),
                    child: Row(
                      children: [
                        ChoiceChip(
                          label: const Text('Changes'),
                          selected: _changes,
                          onSelected: (_) => setState(() {
                            _changes = true;
                            _file = null;
                            _path = null;
                          }),
                        ),
                        const SizedBox(width: 8),
                        ChoiceChip(
                          label: const Text('Files'),
                          selected: !_changes,
                          onSelected: (_) => setState(() {
                            _changes = false;
                            _file = null;
                            _path = null;
                          }),
                        ),
                      ],
                    ),
                  ),
                  Expanded(
                    child: LayoutBuilder(
                      builder: (context, size) {
                        final paths = _changes
                            ? snapshot.changes.map((item) => item.path).toList()
                            : snapshot.files;
                        final list = paths.isEmpty
                            ? _notice(
                                context,
                                _changes
                                    ? 'No uncommitted changes.'
                                    : 'No files yet.',
                              )
                            : ListView.builder(
                                itemCount: paths.length,
                                itemBuilder: (context, index) {
                                  final path = paths[index];
                                  return ListTile(
                                    dense: true,
                                    selected: path == _path,
                                    leading: Icon(
                                      _changes
                                          ? Icons.difference_outlined
                                          : Icons.description_outlined,
                                      size: 17,
                                    ),
                                    title: Text(
                                      path,
                                      maxLines: 2,
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                    trailing: _changes
                                        ? Text(
                                            snapshot.changes[index].label,
                                            style: Theme.of(context)
                                                .textTheme
                                                .labelSmall,
                                          )
                                        : null,
                                    onTap: () => _open(path),
                                  );
                                },
                              );
                        final preview = _file == null
                            ? _notice(
                                context,
                                'Select a file to read it or review its changes.',
                              )
                            : Column(
                                children: [
                                  if (size.maxWidth < 640)
                                    Align(
                                      alignment: Alignment.centerLeft,
                                      child: TextButton.icon(
                                        onPressed: () => setState(() {
                                          _file = null;
                                          _path = null;
                                        }),
                                        icon: const Icon(
                                          Icons.arrow_back_rounded,
                                        ),
                                        label: const Text('Back to files'),
                                      ),
                                    ),
                                  Expanded(
                                    child: FutureBuilder<LocalProjectFile>(
                                      key: ValueKey((_path, _changes)),
                                      future: _file,
                                      builder: (context, file) {
                                        if (file.hasError) {
                                          return _notice(
                                            context,
                                            'This file is unavailable or outside the selected folder.',
                                          );
                                        }
                                        if (file.data == null) {
                                          return const Center(
                                            child: CircularProgressIndicator(),
                                          );
                                        }
                                        final data = file.data!;
                                        return SingleChildScrollView(
                                          padding: const EdgeInsets.all(18),
                                          child: SelectionArea(
                                            child: Column(
                                              crossAxisAlignment:
                                                  CrossAxisAlignment.start,
                                              children: [
                                                Text(
                                                  data.path,
                                                  style: Theme.of(context)
                                                      .textTheme
                                                      .labelLarge,
                                                ),
                                                const SizedBox(height: 14),
                                                Text(
                                                  data.binary
                                                      ? 'Binary file · text preview unavailable'
                                                      : data.content.isEmpty
                                                      ? 'Empty file'
                                                      : data.content,
                                                  style: const TextStyle(
                                                    fontFamily: 'monospace',
                                                    fontSize: 12,
                                                    height: 1.6,
                                                  ),
                                                ),
                                                if (data.truncated)
                                                  const Padding(
                                                    padding: EdgeInsets.only(
                                                      top: 12,
                                                    ),
                                                    child: Text(
                                                      'Preview shortened. The full file remains in your folder.',
                                                    ),
                                                  ),
                                              ],
                                            ),
                                          ),
                                        );
                                      },
                                    ),
                                  ),
                                ],
                              );
                        if (size.maxWidth < 640) {
                          return _file == null ? list : preview;
                        }
                        return Row(
                          children: [
                            SizedBox(width: 280, child: list),
                            const VerticalDivider(width: 1),
                            Expanded(child: preview),
                          ],
                        );
                      },
                    ),
                  ),
                ],
              );
            },
          ),
        ),
      ],
    ),
  );
  Widget _frame(BuildContext context, Widget content) => widget.embedded
      ? content
      : Dialog(
          clipBehavior: Clip.antiAlias,
          child: SizedBox(
            width: 1060,
            height: MediaQuery.sizeOf(context).height * .84,
            child: content,
          ),
        );
  Widget _notice(BuildContext context, String text) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.bodyMedium,
      ),
    ),
  );
}
