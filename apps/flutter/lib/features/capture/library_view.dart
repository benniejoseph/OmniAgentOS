import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/native_workspace_access.dart';
import 'entity_options.dart';
import 'library_contracts.dart';
import 'library_controller.dart';
import 'library_providers.dart';

class LibraryCommandSelection {
  const LibraryCommandSelection(this.item, this.workspaceIdentity);
  final LibraryItem item;
  final Object workspaceIdentity;
  bool matchesCurrent(NativeWorkspaceAccess access) =>
      access.current && access.identity == workspaceIdentity;
}

class LibraryMeetingSelection {
  const LibraryMeetingSelection(this.item, this.workspaceIdentity);
  final LibraryItem item;
  final Object workspaceIdentity;
  bool matchesCurrent(NativeWorkspaceAccess access) =>
      access.current && access.identity == workspaceIdentity;
}

/// Meeting source requests accept current Capture or immutable source revisions.
/// Project/Mission artifact identities have different authority and cannot be
/// relabelled as source revisions by this selector.
bool libraryMeetingSourceAvailable(LibraryItem item) {
  bool sourceId(Object? value) =>
      value is String &&
      value.length <= 240 &&
      RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$').hasMatch(value);
  return item.raw['status'] == 'ready' &&
      const {
        'capture_asset',
        'capture_recording',
        'capture_transcript',
        'source_item',
      }.contains(item.authority) &&
      sourceId(item.sourceId) &&
      (item.authority != 'source_item' ||
          sourceId(item.version['sourceRevisionId']));
}

Future<LibraryMeetingSelection?> showNativeMeetingLibraryPicker(
  BuildContext context,
) => Navigator.of(context).push<LibraryMeetingSelection>(
  MaterialPageRoute(
    builder: (_) => const NativeLibraryPage(selectForMeeting: true),
  ),
);

Future<LibraryCommandSelection?> showNativeLibraryPicker(
  BuildContext context,
) => Navigator.of(context).push<LibraryCommandSelection>(
  MaterialPageRoute(
    builder: (_) => const NativeLibraryPage(selectForCommand: true),
  ),
);

/// Provider-bound read surface; callers may supply an exact published Library ID.
class NativeLibraryPage extends StatelessWidget {
  const NativeLibraryPage({
    super.key,
    this.initialLibraryItemId,
    this.selectForCommand = false,
    this.selectForMeeting = false,
  }) : assert(!selectForCommand || !selectForMeeting);
  final String? initialLibraryItemId;
  final bool selectForCommand;
  final bool selectForMeeting;
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(
        selectForMeeting
            ? 'Choose a Meeting source'
            : selectForCommand
            ? 'Choose current Library context'
            : 'Library',
      ),
    ),
    body: NativePrivateWorkspace(
      builder: (access) => Consumer(
        builder: (context, ref, _) {
          final controller = ref.watch(libraryControllerProvider);
          return controller == null
              ? const Center(
                  child: Text('Library is unavailable for this session.'),
                )
              : LibraryView(
                  key: ObjectKey(controller),
                  controller: controller,
                  initialLibraryItemId: initialLibraryItemId,
                  selectForMeeting: selectForMeeting,
                  onSelectedCurrent: selectForCommand || selectForMeeting
                      ? (item) {
                          if (access.current &&
                              controller.available &&
                              identical(controller.detail, item) &&
                              (!selectForMeeting ||
                                  libraryMeetingSourceAvailable(item))) {
                            Navigator.of(context).pop(
                              selectForMeeting
                                  ? LibraryMeetingSelection(
                                      item,
                                      access.identity,
                                    )
                                  : LibraryCommandSelection(
                                      item,
                                      access.identity,
                                    ),
                            );
                          }
                        }
                      : null,
                );
        },
      ),
    ),
  );
}

class LibraryView extends StatefulWidget {
  const LibraryView({
    super.key,
    required this.controller,
    this.initialLibraryItemId,
    this.onSelectedCurrent,
    this.selectForMeeting = false,
  });
  final LibraryController controller;
  final String? initialLibraryItemId;
  final ValueChanged<LibraryItem>? onSelectedCurrent;
  final bool selectForMeeting;
  @override
  State<LibraryView> createState() => _LibraryViewState();
}

class _LibraryViewState extends State<LibraryView> with WidgetsBindingObserver {
  final _search = TextEditingController(), _exactId = TextEditingController();
  final _listFocus = FocusNode(), _detailFocus = FocusNode();
  final _detailKey = GlobalKey();
  String? _formError;
  String? _kind;
  bool _attaching = false;
  String? _attachmentNotice;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _search.text = widget.controller.query;
    _kind = widget.controller.kind;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      widget.controller.load();
      final id = widget.initialLibraryItemId;
      if (id != null) _open(id, focus: false);
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) =>
      widget.controller.setVisible(state == AppLifecycleState.resumed);
  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _search.dispose();
    _exactId.dispose();
    _listFocus.dispose();
    _detailFocus.dispose();
    super.dispose();
  }

  void _open(String id, {bool focus = true}) {
    if (!widget.controller.available) return;
    if (!RegExp(
          r'^library:(capture_asset|capture_recording|capture_transcript|project_artifact|source_item):.+$',
        ).hasMatch(id) ||
        id.length > 320 ||
        widget.selectForMeeting && id.startsWith('library:project_artifact:')) {
      setState(
        () => _formError = widget.selectForMeeting
            ? 'Choose an exact Capture or connected source ID. Project and Mission artifacts cannot be linked as Meeting sources.'
            : 'Enter an exact current Library ID from a saved source. Legacy Mission artifacts do not support exact opening.',
      );
      return;
    }
    setState(() {
      _formError = null;
      _attachmentNotice = null;
    });
    unawaited(widget.controller.select(id));
    if (focus) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted ||
            !widget.controller.available ||
            widget.controller.selectedId != id) {
          return;
        }
        _detailFocus.requestFocus();
        final context = _detailKey.currentContext;
        if (context != null) Scrollable.ensureVisible(context, alignment: 0.05);
      });
    }
  }

  Future<void> _attach(LibraryItem reviewed) async {
    final c = widget.controller;
    final meetingSelection = widget.selectForMeeting;
    if (_attaching ||
        !c.available ||
        widget.onSelectedCurrent == null ||
        !_selectable(reviewed) ||
        c.selectedId != reviewed.id) {
      return;
    }
    final reviewedReference = _selectionBinding(reviewed);
    setState(() {
      _attaching = true;
      _attachmentNotice = null;
    });
    await c.select(reviewed.id);
    if (!mounted) {
      return;
    }
    try {
      if (!identical(c, widget.controller) ||
          meetingSelection != widget.selectForMeeting) {
        return;
      }
      final current = c.detail;
      if (!c.available ||
          c.selectedId != reviewed.id ||
          c.detailLoading ||
          c.detailError != null ||
          current == null) {
        setState(
          () => _attachmentNotice = 'The exact current source could not be revalidated. Nothing was attached.',
        );
        return;
      }
      if (!_selectable(current) ||
          _selectionBinding(current) != reviewedReference) {
        setState(
          () => _attachmentNotice = 'This source changed. Review its current version before choosing it again.',
        );
        return;
      }
      widget.onSelectedCurrent!(current);
    } finally {
      if (mounted) setState(() => _attaching = false);
    }
  }

  bool _selectable(LibraryItem item) => widget.selectForMeeting
      ? libraryMeetingSourceAvailable(item)
      : item.commandAvailable;
  String _selectionBinding(LibraryItem item) => libraryCanonical(
    widget.selectForMeeting ? item.raw : item.commandReference(),
  );

  Widget _button(
    String label,
    VoidCallback? pressed, {
    String? key,
    IconData? icon,
  }) => Padding(
    padding: const EdgeInsets.all(4),
    child: OutlinedButton.icon(
      key: key == null ? null : Key(key),
      onPressed: pressed,
      style: OutlinedButton.styleFrom(minimumSize: const Size(48, 48)),
      icon: Icon(icon ?? Icons.refresh, size: 18),
      label: Text(label),
    ),
  );
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final c = widget.controller;
      if (!c.available) {
        return Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text(
                  'Library access is unavailable. Private source details have been cleared.',
                ),
                if (c.accessDenied)
                  _button('Retry authorized reads', c.retryAccess),
              ],
            ),
          ),
        );
      }
      final page = c.page;
      final rows =
          page?.items
              .where(
                (item) =>
                    !widget.selectForMeeting ||
                    libraryMeetingSourceAvailable(item),
              )
              .toList() ??
          const <LibraryItem>[];
      return SingleChildScrollView(
        key: const Key('library-scroll'),
        padding: const EdgeInsets.all(24),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 1120),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'Current sources and retained versions',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 8),
                Text(
                  widget.selectForMeeting
                      ? 'Choose a ready current Capture or connected source. Project and Mission artifacts are excluded. The exact current source is read again before returning to the Meeting draft.'
                      : 'Read the source identity, current revision and exact citations. History contains retained metadata; it does not grant access to historical file bytes or attach an older version to Command.',
                ),
                const SizedBox(height: 16),
                TextField(
                  key: const Key('library-search'),
                  controller: _search,
                  maxLength: 240,
                  decoration: const InputDecoration(
                    labelText: 'Search Library',
                    hintText: 'Title or source context',
                  ),
                  textInputAction: TextInputAction.search,
                  onSubmitted: (value) => c.search(value, _kind),
                ),
                Wrap(
                  spacing: 12,
                  runSpacing: 8,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 320),
                      child: DropdownButtonFormField<String>(
                        initialValue: _kind ?? 'all',
                        isExpanded: true,
                        itemHeight: null,
                        decoration: const InputDecoration(
                          labelText: 'Source kind',
                        ),
                        items: [
                          const DropdownMenuItem(
                            value: 'all',
                            child: Text('All kinds'),
                          ),
                          for (final kind in libraryKinds)
                            DropdownMenuItem(
                              value: kind,
                              child: Text(kind.replaceAll('_', ' ')),
                            ),
                        ],
                        onChanged: (value) {
                          setState(() => _kind = value == 'all' ? null : value);
                          c.search(_search.text, _kind);
                        },
                      ),
                    ),
                    _button(
                      'Search',
                      () => c.search(_search.text, _kind),
                      key: 'library-search-submit',
                      icon: Icons.search,
                    ),
                    _button(
                      'Refresh Library',
                      () => c.load(),
                      key: 'library-refresh',
                    ),
                    _button(
                      'Browse authorized entities',
                      () => Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => const NativeEntityOptionsPage(),
                        ),
                      ),
                      icon: Icons.account_tree_outlined,
                    ),
                  ],
                ),
                ExpansionTile(
                  title: const Text('Open an exact source'),
                  childrenPadding: const EdgeInsets.all(16),
                  children: [
                    TextField(
                      key: const Key('library-exact-id'),
                      controller: _exactId,
                      maxLength: 320,
                      decoration: const InputDecoration(
                        labelText: 'Exact Library ID',
                      ),
                      onSubmitted: (value) => _open(value.trim()),
                    ),
                    if (_formError != null)
                      Semantics(liveRegion: true, child: Text(_formError!)),
                    Align(
                      alignment: AlignmentDirectional.centerStart,
                      child: _button(
                        'Read exact source',
                        () => _open(_exactId.text.trim()),
                        key: 'library-exact-read',
                        icon: Icons.description_outlined,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                Focus(
                  focusNode: _listFocus,
                  child: Semantics(
                    header: true,
                    child: Text(
                      'Library records',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                  ),
                ),
                if (c.listLoading)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 12),
                    child: Text('Reading the current Library page…'),
                  ),
                if (c.listError != null)
                  LibraryReadNotice(
                    c.listError!,
                    retry: () => c.load(),
                    stale: page != null,
                  ),
                if (page == null && !c.listLoading)
                  const Text(
                    'Record counts are unavailable until a valid page is read.',
                  ),
                if (page != null) ...[
                  SelectableText(
                    '${c.listError != null || c.listLoading ? 'Last loaded' : 'Loaded'} ${page.items.length} records${page.items.isEmpty ? '' : ' · positions ${page.offset + 1}–${page.offset + page.items.length}'} · ${page.total}${page.lowerBound ? '+' : ''} matching records',
                  ),
                  Text(
                    'Counts ${page.countsLowerBound ? 'are lower bounds' : 'describe the returned search window'}. Read at ${page.generatedAt}.',
                  ),
                  if (widget.selectForMeeting)
                    Text(
                      '${rows.length} suitable Meeting sources in this loaded page. Library totals include other source types; use the next page or narrow the search to continue.',
                    ),
                  if (page.items.isEmpty)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 20),
                      child: Text(
                        'No records matched this search in the current readable Library.',
                      ),
                    ),
                  for (final row in rows)
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        const Divider(),
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 8),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              SelectableText(
                                row.title,
                                style: Theme.of(context).textTheme.titleMedium,
                              ),
                              Text(
                                '${row.kind.replaceAll('_', ' ')} · ${row.raw['status']} · ${row.raw['sourceLabel']}',
                              ),
                              SelectableText(
                                'Version ${row.version['versionNumber']} · ${row.raw['versionCount']} known versions',
                              ),
                              if (row.exactAvailable)
                                Align(
                                  alignment: AlignmentDirectional.centerStart,
                                  child: _button(
                                    c.selectedId == row.id
                                        ? 'Read selected source'
                                        : 'Inspect source',
                                    () => _open(row.id),
                                    icon: Icons.description_outlined,
                                  ),
                                ),
                              if (!row.exactAvailable) ...[
                                const Text(
                                  'Legacy Mission artifact · exact source/history reads are unavailable in this contract.',
                                ),
                                LibraryValue('Library ID', row.id),
                                LibraryValue(
                                  'Citations',
                                  (row.raw['citationRefs'] as List).join('\n'),
                                ),
                              ],
                            ],
                          ),
                        ),
                      ],
                    ),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      _button(
                        'Previous records',
                        c.hasPrevious && !c.listLoading ? c.previous : null,
                        key: 'library-previous',
                        icon: Icons.chevron_left,
                      ),
                      _button(
                        'Next records',
                        page.nextOffset != null &&
                                page.nextOffset! <= 10000 &&
                                !c.listLoading
                            ? c.next
                            : null,
                        key: 'library-next',
                        icon: Icons.chevron_right,
                      ),
                    ],
                  ),
                  if (page.nextOffset != null && page.nextOffset! > 10000)
                    const Text(
                      'The bounded browsing limit has been reached. Narrow the search to continue.',
                    ),
                ],
                if (c.selectedId != null) ...[
                  const SizedBox(height: 32),
                  const Divider(),
                  Focus(
                    key: _detailKey,
                    focusNode: _detailFocus,
                    child: Semantics(
                      header: true,
                      child: Text(
                        'Selected source',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                    ),
                  ),
                  LibraryValue('Requested Library ID', c.selectedId),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      _button(
                        'Refresh selected source',
                        () => c.select(c.selectedId!),
                        key: 'library-detail-refresh',
                      ),
                      _button(
                        'Close source',
                        () {
                          c.clearSelection();
                          _listFocus.requestFocus();
                        },
                        key: 'library-detail-close',
                        icon: Icons.close,
                      ),
                    ],
                  ),
                  if (c.detailLoading)
                    const Text('Reading the exact current source…'),
                  if (c.detailError != null)
                    LibraryReadNotice(
                      c.detailError!,
                      retry: () => c.select(c.selectedId!),
                      stale: c.detail != null,
                    ),
                  if (c.detail != null) _detail(context, c.detail!, c),
                ],
              ],
            ),
          ),
        ),
      );
    },
  );
  Widget _detail(
    BuildContext context,
    LibraryItem item,
    LibraryController c,
  ) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      SelectableText(item.title, style: Theme.of(context).textTheme.titleLarge),
      if (item.raw['summary'] != '')
        SelectableText(item.raw['summary'] as String),
      if (c.detailLoading ||
          c.detailError != null ||
          c.historyPage != null && c.historyPage!.head != item.versionId)
        const Text(
          'This is the last loaded current record. Refresh it before relying on its current version.',
        ),
      LibraryValue('Source', '${item.authority}\n${item.sourceId}'),
      LibraryValue('State', item.raw['status']),
      LibraryValue(
        'Scope',
        '${item.scope['visibility']} · ${item.scope['permissionBasis']}',
      ),
      LibraryValue('Owner', item.scope['ownerActorId']),
      for (final key in ['workspaceId', 'projectId', 'workItemId', 'missionId'])
        if (item.scope[key] != null) LibraryValue(key, item.scope[key]),
      LibraryValue(
        'Current version',
        '${item.versionId}\nVersion ${item.version['versionNumber']} of ${item.raw['versionCount']} known',
      ),
      LibraryValue(
        'Source revision',
        item.version['sourceRevisionId'] ??
            'No revision ID in this source projection',
      ),
      LibraryValue('Content SHA-256', item.version['contentSha256']),
      LibraryValue(
        'Content description',
        '${item.version['byteCount']} bytes · ${item.version['mediaType']}',
      ),
      LibraryValue('Version created', item.version['createdAt']),
      LibraryValue('Record updated', item.raw['updatedAt']),
      LibraryValue(
        'Tags',
        (item.raw['tags'] as List).isEmpty
            ? 'No saved tags'
            : (item.raw['tags'] as List).join(', '),
      ),
      LibraryValue(
        'Exact citations',
        (item.raw['citationRefs'] as List).join('\n'),
      ),
      LibraryCopyButton(
        label: 'Copy current citations',
        value: (item.raw['citationRefs'] as List).join('\n'),
        current: () =>
            c.available &&
            c.detail?.versionId == item.versionId &&
            c.detail?.id == item.id,
      ),
      if (widget.onSelectedCurrent != null) ...[
        Text(
          widget.selectForMeeting
              ? 'This exact current source is read again now. Linking only changes your private Meeting draft; the server revalidates access and consent when you save the reviewed Meeting.'
              : 'Only this exact current version can be selected. The source is read again now and revalidated again by the server when you explicitly send the conversation.',
        ),
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: _button(
            _attaching
                ? 'Checking current version…'
                : 'Use this current version',
            !_attaching &&
                    !c.detailLoading &&
                    c.detailError == null &&
                    _selectable(item)
                ? () => _attach(item)
                : null,
            key: 'library-select-current',
            icon: Icons.attach_file,
          ),
        ),
        if (!_selectable(item))
          Text(
            widget.selectForMeeting
                ? 'This source cannot be linked to a Meeting. Choose a ready Capture or connected source with an exact supported identity.'
                : 'This source is not ready for current-version conversation context.',
          ),
        if (_attachmentNotice != null)
          Semantics(liveRegion: true, child: Text(_attachmentNotice!)),
      ],
      ExpansionTile(
        title: const Text('Source and related destinations'),
        childrenPadding: const EdgeInsets.all(16),
        children: [
          const Text(
            'These are source-provided destinations. They do not grant download, ingestion or historical attachment authority.',
          ),
          LibraryValue(
            'Current source destination',
            item.raw['openHref'] ?? 'Unavailable',
          ),
          for (final row in item.raw['links'] as List)
            LibraryValue(
              '${row['kind']} · ${row['label']}',
              '${row['id']}\n${row['href'] ?? 'No destination'}',
            ),
        ],
      ),
      const SizedBox(height: 24),
      Text('Version history', style: Theme.of(context).textTheme.titleLarge),
      const Text(
        'Retained metadata only. An older content digest or citation is evidence of that stored revision, not proof that its bytes can be read or attached now. Use “Attach from Library” in the conversation composer to choose a current version.',
      ),
      Wrap(
        spacing: 8,
        children: [
          _button(
            c.historyPage == null
                ? 'Read version history'
                : 'Restart version history',
            () => c.loadHistory(restart: true),
            key: 'library-history-read',
            icon: Icons.history,
          ),
        ],
      ),
      if (c.historyLoading) const Text('Reading retained version metadata…'),
      if (c.historyError != null)
        LibraryReadNotice(
          c.historyError!,
          retry: () => c.loadHistory(restart: c.historyChanged),
          stale: c.historyPage != null,
        ),
      if (c.historyPage != null) ...[
        LibraryValue('History current-head pin', c.historyPage!.head),
        Text(
          c.historyPage!.basis == 'current_known_version_only'
              ? 'This source exposes only its current known version.'
              : 'This page contains retained compatible revisions. The complete historical total is unavailable.',
        ),
        Text(
          '${c.historyPage!.versions.length} versions loaded${c.historyPage!.nextBefore != null ? ' · more available' : ' · end of this readable history'}.',
        ),
        for (final version in c.historyPage!.versions)
          Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Divider(),
              LibraryValue(
                version.current ? 'Current version' : 'Historical version',
                version.id,
              ),
              Text(
                '${version.raw['capturedAt']} · ${version.raw['byteCount']} bytes · ${version.raw['mediaType']}',
              ),
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: _button(
                  'Inspect exact version',
                  c.historyChanged ? null : () => c.selectVersion(version.id),
                  icon: Icons.manage_search,
                ),
              ),
            ],
          ),
        Wrap(
          spacing: 8,
          children: [
            _button(
              'Previous versions',
              c.historyHasPrevious && !c.historyLoading && !c.historyChanged
                  ? c.previousHistory
                  : null,
              icon: Icons.chevron_left,
            ),
            _button(
              'Older versions',
              c.historyPage!.nextBefore != null &&
                      !c.historyLoading &&
                      !c.historyChanged
                  ? c.nextHistory
                  : null,
              icon: Icons.chevron_right,
            ),
          ],
        ),
      ],
      if (c.selectedVersionId != null) ...[
        LibraryValue('Requested historical version', c.selectedVersionId),
        if (c.versionLoading)
          const Text(
            'Reading this exact version against the current-head pin…',
          ),
        if (c.versionError != null)
          LibraryReadNotice(
            c.versionError!,
            retry: () => c.historyChanged
                ? c.loadHistory(restart: true)
                : c.selectVersion(c.selectedVersionId!),
          ),
        if (c.versionRead != null) ...[
          Text(
            'Exact version metadata',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          for (final key in [
            'versionId',
            'sourceRevisionId',
            'sourceRevisionSha256',
            'contentSha256',
            'byteCount',
            'mediaType',
            'capturedAt',
          ])
            LibraryValue(
              key,
              c.versionRead!.versions.single.raw[key] ??
                  'Unavailable for this source',
            ),
          LibraryValue(
            'Exact version citations',
            (c.versionRead!.versions.single.raw['citationRefs'] as List).join(
              '\n',
            ),
          ),
          LibraryCopyButton(
            label: 'Copy version citations',
            value: (c.versionRead!.versions.single.raw['citationRefs'] as List)
                .join('\n'),
            current: () =>
                c.available && !c.historyChanged && c.versionRead != null,
          ),
        ],
      ],
    ],
  );
}

class LibraryValue extends StatelessWidget {
  const LibraryValue(this.label, this.value, {super.key});
  final String label;
  final Object? value;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(label, style: Theme.of(context).textTheme.labelLarge),
        const SizedBox(height: 2),
        SelectableText(value?.toString() ?? 'Unavailable'),
      ],
    ),
  );
}

class LibraryReadNotice extends StatelessWidget {
  const LibraryReadNotice(
    this.message, {
    super.key,
    required this.retry,
    this.stale = false,
  });
  final String message;
  final VoidCallback retry;
  final bool stale;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 12),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          liveRegion: true,
          child: Text(
            '$message${stale ? ' Last-loaded data is retained below.' : ''}',
          ),
        ),
        TextButton(
          onPressed: retry,
          style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
          child: const Text('Retry read'),
        ),
      ],
    ),
  );
}

class LibraryCopyButton extends StatefulWidget {
  const LibraryCopyButton({
    super.key,
    required this.label,
    required this.value,
    required this.current,
  });
  final String label, value;
  final bool Function() current;
  @override
  State<LibraryCopyButton> createState() => _LibraryCopyButtonState();
}

class _LibraryCopyButtonState extends State<LibraryCopyButton> {
  String? _notice;
  bool _busy = false;
  @override
  void didUpdateWidget(covariant LibraryCopyButton oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.value != widget.value) _notice = null;
  }

  Future<void> _copy() async {
    if (_busy || !widget.current()) return;
    final value = widget.value;
    setState(() {
      _busy = true;
      _notice = null;
    });
    try {
      await Clipboard.setData(ClipboardData(text: value));
      if (mounted && widget.value == value && widget.current()) {
        setState(() => _notice = 'Copied to clipboard.');
      }
    } catch (_) {
      if (mounted && widget.current()) {
        setState(
          () => _notice =
              'Copy did not finish. Select the full value above to copy it.',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      TextButton.icon(
        onPressed: _busy || !widget.current() ? null : _copy,
        style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
        icon: const Icon(Icons.copy_outlined, size: 18),
        label: Text(widget.label),
      ),
      if (_notice != null) Semantics(liveRegion: true, child: Text(_notice!)),
    ],
  );
}
