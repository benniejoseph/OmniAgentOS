import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

const talkCommandContextKinds = <String>{
  'agent',
  'skill',
  'plugin',
  'project',
  'integration',
  'file',
};

class TalkCommandContextReference {
  const TalkCommandContextReference({
    required this.kind,
    required this.id,
    required this.label,
    required this.description,
    required this.selectable,
    this.state,
    this.sourceId,
    this.expectedVersion,
    this.versionId,
    this.bindingSha256,
  });

  factory TalkCommandContextReference.fromJson(Map<String, dynamic> json) {
    final kind = json['kind']?.toString() ?? '';
    final id = json['id']?.toString() ?? '';
    final label = json['label']?.toString() ?? '';
    final description = json['description']?.toString() ?? '';
    final expectedVersion = (json['expectedVersion'] as num?)?.toInt();
    final bindingSha256 = json['bindingSha256']?.toString();
    if (!talkCommandContextKinds.contains(kind) ||
        id.isEmpty ||
        id.length > 320 ||
        label.isEmpty ||
        label.length > 240 ||
        description.length > 1000 ||
        (expectedVersion != null && expectedVersion < 1) ||
        (bindingSha256 != null &&
            !RegExp(r'^[a-f0-9]{64}$').hasMatch(bindingSha256))) {
      throw const FormatException('The Command context catalog was invalid.');
    }
    return TalkCommandContextReference(
      kind: kind,
      id: id,
      label: label,
      description: description,
      state: json['state']?.toString(),
      selectable: json['selectable'] == true,
      sourceId: json['sourceId']?.toString(),
      expectedVersion: expectedVersion,
      versionId: json['versionId']?.toString(),
      bindingSha256: bindingSha256,
    );
  }

  final String kind;
  final String id;
  final String label;
  final String description;
  final String? state;
  final bool selectable;
  final String? sourceId;
  final int? expectedVersion;
  final String? versionId;
  final String? bindingSha256;

  String get key => '$kind:$id';

  Map<String, dynamic> toRequestJson() => {
    'kind': kind,
    'id': id,
    if (expectedVersion != null) 'expectedVersion': expectedVersion,
    if (versionId != null) 'versionId': versionId,
    if (bindingSha256 != null) 'bindingSha256': bindingSha256,
  };
}

class TalkCommandContextCatalog {
  const TalkCommandContextCatalog({required this.items});

  factory TalkCommandContextCatalog.fromJson(Map<String, dynamic> json) {
    if (json['version'] != 1 || json['items'] is! List) {
      throw const FormatException('The Command context catalog was invalid.');
    }
    return TalkCommandContextCatalog(
      items: List.unmodifiable(
        (json['items'] as List).map((value) {
          if (value is! Map) {
            throw const FormatException(
              'The Command context catalog was invalid.',
            );
          }
          return TalkCommandContextReference.fromJson(
            Map<String, dynamic>.from(value),
          );
        }),
      ),
    );
  }

  final List<TalkCommandContextReference> items;
}

class TalkCommandComposer extends StatefulWidget {
  const TalkCommandComposer({
    super.key,
    required this.controller,
    required this.focusNode,
    required this.selected,
    required this.catalogLoader,
    required this.onSelected,
    required this.onRemoved,
    required this.onApproach,
    required this.onSubmitted,
    required this.hintText,
    this.disabled = false,
    this.autofocus = false,
    this.minLines = 1,
    this.maxLines = 5,
    this.suffixIcon,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final List<TalkCommandContextReference> selected;
  final Future<TalkCommandContextCatalog> Function() catalogLoader;
  final ValueChanged<TalkCommandContextReference> onSelected;
  final ValueChanged<TalkCommandContextReference> onRemoved;
  final ValueChanged<String> onApproach;
  final ValueChanged<String>? onSubmitted;
  final String hintText;
  final bool disabled;
  final bool autofocus;
  final int minLines;
  final int maxLines;
  final Widget? suffixIcon;

  @override
  State<TalkCommandComposer> createState() => _TalkCommandComposerState();
}

class _TalkCommandComposerState extends State<TalkCommandComposer> {
  _ComposerTrigger? trigger;
  TalkCommandContextCatalog? catalog;
  Object? catalogError;
  bool loading = false;
  int activeIndex = 0;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onTextChanged);
  }

  @override
  void didUpdateWidget(covariant TalkCommandComposer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_onTextChanged);
      widget.controller.addListener(_onTextChanged);
      _onTextChanged();
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onTextChanged);
    super.dispose();
  }

  void _onTextChanged() {
    final next = _triggerAtSelection(widget.controller);
    if (next == trigger) return;
    setState(() {
      trigger = next;
      activeIndex = 0;
    });
    if (next != null && catalog == null && !loading) _loadCatalog();
  }

  Future<void> _loadCatalog() async {
    setState(() {
      loading = true;
      catalogError = null;
    });
    try {
      final next = await widget.catalogLoader();
      if (!mounted) return;
      setState(() => catalog = next);
    } catch (error) {
      if (!mounted) return;
      setState(() => catalogError = error);
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  List<_ComposerChoiceGroup> get choiceGroups {
    final current = trigger;
    if (current == null) return const [];
    final query = current.query.trim().toLowerCase();
    bool matches(String label, String description) =>
        query.isEmpty ||
        label.toLowerCase().contains(query) ||
        description.toLowerCase().contains(query);
    final selectedKeys = widget.selected.map((item) => item.key).toSet();

    if (current.symbol == '/') {
      const approaches = <_ComposerChoice>[
        _ComposerChoice.approach(
          'orchestrate',
          'Best approach',
          'Let Asael choose the right way to handle this.',
        ),
        _ComposerChoice.approach(
          'research',
          'Research',
          'Use current sources and preserve citations.',
        ),
        _ComposerChoice.approach(
          'execute',
          'Act',
          'Use connected services through governed actions.',
        ),
        _ComposerChoice.approach(
          'learn',
          'Learn',
          'Explain, organize, and form useful knowledge.',
        ),
      ];
      final matchingApproaches = approaches
          .where((item) => matches(item.label, item.description))
          .toList(growable: false);
      final skills = (catalog?.items ?? const <TalkCommandContextReference>[])
          .where(
            (item) =>
                item.kind == 'skill' &&
                item.selectable &&
                !selectedKeys.contains(item.key) &&
                matches(
                  item.label,
                  '${_kindSearchTerms(item.kind)} ${item.description}',
                ),
          )
          .take(8)
          .map(_ComposerChoice.reference)
          .toList(growable: false);
      return [
        if (matchingApproaches.isNotEmpty)
          _ComposerChoiceGroup(
            kind: 'approach',
            title: 'Approaches',
            description: 'Choose how Asael should handle this request',
            items: matchingApproaches,
          ),
        if (skills.isNotEmpty)
          _ComposerChoiceGroup(
            kind: 'skill',
            title: 'Skills',
            description: 'Reusable instructions that guide the work',
            items: skills,
          ),
      ];
    }

    final matchesByKind = <String, List<TalkCommandContextReference>>{
      for (final kind in _contextKindOrder)
        kind: <TalkCommandContextReference>[],
    };
    for (final item
        in catalog?.items ?? const <TalkCommandContextReference>[]) {
      if (!item.selectable || selectedKeys.contains(item.key)) continue;
      if (!matchesByKind.containsKey(item.kind)) continue;
      if (!matches(
        item.label,
        '${_kindSearchTerms(item.kind)} ${item.description}',
      )) {
        continue;
      }
      matchesByKind[item.kind]!.add(item);
    }

    final balanced = _balancedContextReferences(matchesByKind, limit: 18);
    return [
      for (final kind in _contextKindOrder)
        if (balanced[kind]?.isNotEmpty == true)
          _ComposerChoiceGroup(
            kind: kind,
            title: _kindGroupTitle(kind),
            description: _kindGroupDescription(kind),
            items: balanced[kind]!
                .map(_ComposerChoice.reference)
                .toList(growable: false),
          ),
    ];
  }

  List<_ComposerChoice> get choices => [
    for (final group in choiceGroups) ...group.items,
  ];

  KeyEventResult _handleKey(FocusNode _, KeyEvent event) {
    final items = choices;
    if (trigger == null || event is! KeyDownEvent) {
      return KeyEventResult.ignored;
    }
    if (event.logicalKey == LogicalKeyboardKey.escape) {
      setState(() => trigger = null);
      return KeyEventResult.handled;
    }
    if (items.isEmpty) return KeyEventResult.ignored;
    if (event.logicalKey == LogicalKeyboardKey.arrowDown ||
        event.logicalKey == LogicalKeyboardKey.arrowUp) {
      setState(() {
        final direction = event.logicalKey == LogicalKeyboardKey.arrowDown
            ? 1
            : -1;
        activeIndex = (activeIndex + direction + items.length) % items.length;
      });
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.enter &&
        !HardwareKeyboard.instance.isShiftPressed) {
      _choose(items[activeIndex.clamp(0, items.length - 1)]);
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  void _choose(_ComposerChoice choice) {
    _removeTrigger();
    if (choice.approach != null) {
      widget.onApproach(choice.approach!);
    } else if (choice.reference != null) {
      widget.onSelected(choice.reference!);
    }
  }

  void _removeTrigger() {
    final current = trigger;
    if (current == null) return;
    final value = widget.controller.text;
    final next =
        '${value.substring(0, current.start)}${value.substring(current.end)}'
            .replaceAll(RegExp(r' {2,}'), ' ');
    widget.controller.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(
        offset: current.start.clamp(0, next.length),
      ),
    );
    setState(() => trigger = null);
    widget.focusNode.requestFocus();
  }

  List<Widget> _buildChoiceGroups(
    BuildContext context,
    List<_ComposerChoiceGroup> groups,
    int safeIndex,
  ) {
    final theme = Theme.of(context);
    final widgets = <Widget>[];
    var choiceIndex = 0;
    for (final group in groups) {
      widgets.add(
        Padding(
          padding: EdgeInsets.fromLTRB(12, widgets.isEmpty ? 8 : 12, 12, 5),
          child: Row(
            children: [
              Icon(
                _kindIcon(group.kind),
                size: 14,
                color: theme.colorScheme.primary,
              ),
              const SizedBox(width: 7),
              Expanded(
                child: Text(
                  group.title,
                  style: theme.textTheme.labelMedium?.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              Text(
                '${group.items.length}',
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      );
      widgets.add(
        Padding(
          padding: const EdgeInsets.fromLTRB(33, 0, 12, 5),
          child: Align(
            alignment: Alignment.centerLeft,
            child: Text(
              group.description,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        ),
      );
      for (final item in group.items) {
        final index = choiceIndex++;
        final selected = index == safeIndex;
        widgets.add(
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
            child: MouseRegion(
              cursor: SystemMouseCursors.click,
              onEnter: (_) {
                if (activeIndex != index) setState(() => activeIndex = index);
              },
              child: ListTile(
                dense: true,
                selected: selected,
                selectedTileColor: theme.colorScheme.primaryContainer
                    .withValues(alpha: 0.46),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
                leading: Container(
                  width: 32,
                  height: 32,
                  decoration: BoxDecoration(
                    color: selected
                        ? theme.colorScheme.primary.withValues(alpha: 0.12)
                        : theme.colorScheme.surfaceContainerHighest,
                    shape: BoxShape.circle,
                  ),
                  child: Icon(
                    _kindIcon(item.kind),
                    size: 17,
                    color: theme.colorScheme.primary,
                  ),
                ),
                title: Text(
                  item.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                subtitle: Text(
                  item.description,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                trailing: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 112),
                  child: Text(
                    _kindAliasLabel(item.kind),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.end,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
                onTap: () => _choose(item),
              ),
            ),
          ),
        );
      }
    }
    return widgets;
  }

  @override
  Widget build(BuildContext context) {
    final groups = choiceGroups;
    final items = [for (final group in groups) ...group.items];
    final safeIndex = items.isEmpty
        ? 0
        : activeIndex.clamp(0, items.length - 1);
    final menuTitle = trigger?.symbol == '/'
        ? 'Choose an approach or Skill'
        : 'Add context to this command';
    final menuDescription = trigger?.symbol == '/'
        ? 'Pick a working style or reusable Skill.'
        : 'Files and capabilities are attached exactly; actions still follow approvals.';
    return Focus(
      onKeyEvent: _handleKey,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (trigger != null)
            Container(
              constraints: const BoxConstraints(maxHeight: 360),
              margin: const EdgeInsets.only(bottom: 8),
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.surfaceContainerHigh,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(
                  color: Theme.of(context).colorScheme.outlineVariant,
                ),
                boxShadow: const [
                  BoxShadow(
                    blurRadius: 24,
                    offset: Offset(0, 10),
                    color: Color(0x24000000),
                  ),
                ],
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
                    child: Row(
                      children: [
                        CircleAvatar(radius: 14, child: Text(trigger!.symbol)),
                        const SizedBox(width: 9),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                menuTitle,
                                style: Theme.of(context).textTheme.labelLarge,
                              ),
                              const SizedBox(height: 1),
                              Text(
                                menuDescription,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: Theme.of(context).textTheme.bodySmall
                                    ?.copyWith(
                                      color: Theme.of(context)
                                          .colorScheme
                                          .onSurfaceVariant,
                                    ),
                              ),
                            ],
                          ),
                        ),
                        if (loading)
                          const SizedBox.square(
                            dimension: 15,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                      ],
                    ),
                  ),
                  const Divider(height: 1),
                  if (catalogError != null && items.isEmpty)
                    Padding(
                      padding: const EdgeInsets.all(14),
                      child: Column(
                        children: [
                          const Text('Context is temporarily unavailable.'),
                          const SizedBox(height: 6),
                          TextButton.icon(
                            onPressed: loading ? null : _loadCatalog,
                            icon: const Icon(Icons.refresh_rounded, size: 16),
                            label: const Text('Try again'),
                          ),
                        ],
                      ),
                    )
                  else if (!loading && items.isEmpty)
                    Padding(
                      padding: const EdgeInsets.all(14),
                      child: Text(
                        trigger!.symbol == '/'
                            ? 'No matching approach or Skill.'
                            : 'No matching context. Try a different name.',
                      ),
                    )
                  else
                    Flexible(
                      child: ListView(
                        shrinkWrap: true,
                        padding: const EdgeInsets.only(bottom: 7),
                        children: _buildChoiceGroups(
                          context,
                          groups,
                          safeIndex,
                        ),
                      ),
                    ),
                  if (catalogError != null && items.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(12, 4, 12, 9),
                      child: Row(
                        children: [
                          Icon(
                            Icons.cloud_off_outlined,
                            size: 14,
                            color: Theme.of(context)
                                .colorScheme
                                .onSurfaceVariant,
                          ),
                          const SizedBox(width: 6),
                          const Expanded(
                            child: Text(
                              'Saved choices are available; live context could not refresh.',
                            ),
                          ),
                          TextButton(
                            onPressed: loading ? null : _loadCatalog,
                            child: const Text('Retry'),
                          ),
                        ],
                      ),
                    ),
                  if (items.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(12, 6, 12, 9),
                      child: Row(
                        children: [
                          Text(
                            '↑↓ choose  ·  Enter add  ·  Esc close',
                            style: Theme.of(context).textTheme.labelSmall
                                ?.copyWith(
                                  color: Theme.of(context)
                                      .colorScheme
                                      .onSurfaceVariant,
                                ),
                          ),
                          const Spacer(),
                          Text(
                            '${widget.selected.length} attached',
                            style: Theme.of(context).textTheme.labelSmall
                                ?.copyWith(
                                  color: Theme.of(context)
                                      .colorScheme
                                      .onSurfaceVariant,
                                ),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
          if (widget.selected.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  for (final item in widget.selected)
                    InputChip(
                      avatar: Icon(_kindIcon(item.kind), size: 15),
                      label: Text(item.label),
                      tooltip: '${_kindLabel(item.kind)} · ${item.description}',
                      onDeleted: widget.disabled
                          ? null
                          : () => widget.onRemoved(item),
                    ),
                ],
              ),
            ),
          TextField(
            controller: widget.controller,
            focusNode: widget.focusNode,
            autofocus: widget.autofocus,
            enabled: !widget.disabled,
            minLines: widget.minLines,
            maxLines: widget.maxLines,
            textInputAction: TextInputAction.send,
            onSubmitted: widget.onSubmitted,
            decoration: InputDecoration(
              hintText: widget.hintText,
              helperText: '/ approaches + Skills  ·  @ Files, Agents, Projects, Skills, Extensions + Connections',
              helperMaxLines: 2,
              filled: true,
              suffixIcon: widget.suffixIcon,
            ),
          ),
        ],
      ),
    );
  }
}

class _ComposerTrigger {
  const _ComposerTrigger({
    required this.symbol,
    required this.query,
    required this.start,
    required this.end,
  });

  final String symbol;
  final String query;
  final int start;
  final int end;

  @override
  bool operator ==(Object other) =>
      other is _ComposerTrigger &&
      other.symbol == symbol &&
      other.query == query &&
      other.start == start &&
      other.end == end;

  @override
  int get hashCode => Object.hash(symbol, query, start, end);
}

class _ComposerChoice {
  const _ComposerChoice.approach(this.approach, this.label, this.description)
    : reference = null,
      kind = 'approach';

  _ComposerChoice.reference(TalkCommandContextReference value)
    : reference = value,
      approach = null,
      label = value.label,
      description = value.description,
      kind = value.kind;

  final String? approach;
  final TalkCommandContextReference? reference;
  final String label;
  final String description;
  final String kind;
}

class _ComposerChoiceGroup {
  const _ComposerChoiceGroup({
    required this.kind,
    required this.title,
    required this.description,
    required this.items,
  });

  final String kind;
  final String title;
  final String description;
  final List<_ComposerChoice> items;
}

const _contextKindOrder = <String>[
  'file',
  'agent',
  'project',
  'skill',
  'plugin',
  'integration',
];

Map<String, List<TalkCommandContextReference>> _balancedContextReferences(
  Map<String, List<TalkCommandContextReference>> matchesByKind, {
  required int limit,
}) {
  final result = <String, List<TalkCommandContextReference>>{
    for (final kind in _contextKindOrder) kind: <TalkCommandContextReference>[],
  };
  var used = 0;

  // Reserve the first three places for every available kind so a long File or
  // Skill catalog cannot hide Agents, Projects, Extensions, or Connections.
  for (final kind in _contextKindOrder) {
    final candidates =
        matchesByKind[kind] ?? const <TalkCommandContextReference>[];
    final take = candidates.length < 3 ? candidates.length : 3;
    result[kind]!.addAll(candidates.take(take));
    used += take;
  }

  // Share unused places across the remaining groups one result at a time. The
  // menu is grouped again for display after the balanced set has been chosen.
  var depth = 3;
  while (used < limit) {
    var added = false;
    for (final kind in _contextKindOrder) {
      if (used >= limit) break;
      final candidates =
          matchesByKind[kind] ?? const <TalkCommandContextReference>[];
      if (depth >= candidates.length) continue;
      result[kind]!.add(candidates[depth]);
      used += 1;
      added = true;
    }
    if (!added) break;
    depth += 1;
  }
  return result;
}

_ComposerTrigger? _triggerAtSelection(TextEditingController controller) {
  final selection = controller.selection;
  final caret = selection.isValid
      ? selection.extentOffset
      : controller.text.length;
  if (caret < 0 || caret > controller.text.length) return null;
  final before = controller.text.substring(0, caret);
  final match = RegExp(r'(?:^|\s)([/@])([^\s/@]*)$').firstMatch(before);
  if (match == null) return null;
  final matched = match.group(0)!;
  final leading = matched.length - matched.trimLeft().length;
  return _ComposerTrigger(
    symbol: match.group(1)!,
    query: match.group(2) ?? '',
    start: match.start + leading,
    end: caret,
  );
}

String _kindLabel(String kind) => switch (kind) {
  'agent' => 'Agent',
  'skill' => 'Skill',
  'plugin' => 'Extension',
  'project' => 'Project',
  'integration' => 'Connection',
  'file' => 'File',
  _ => 'Approach',
};

String _kindAliasLabel(String kind) => switch (kind) {
  'plugin' => 'Plugin · Extension',
  'integration' => 'Integration · Connection',
  _ => _kindLabel(kind),
};

String _kindSearchTerms(String kind) => switch (kind) {
  'agent' => 'agent agents assistant assistants',
  'skill' => 'skill skills capability capabilities',
  'plugin' => 'plugin plugins extension extensions',
  'project' => 'project projects workspace workspaces',
  'integration' =>
    'integration integrations connection connections account accounts',
  'file' => 'file files document documents attachment attachments',
  _ => 'approach approaches',
};

String _kindGroupTitle(String kind) => switch (kind) {
  'file' => 'Files',
  'agent' => 'Agents',
  'project' => 'Projects',
  'skill' => 'Skills',
  'plugin' => 'Plugins · Extensions',
  'integration' => 'Integrations · Connections',
  _ => 'Approaches',
};

String _kindGroupDescription(String kind) => switch (kind) {
  'file' => 'Indexed documents and media',
  'agent' => 'Choose who should handle the work',
  'project' => 'Use the project’s exact working context',
  'skill' => 'Reusable instructions that guide the work',
  'plugin' => 'Installed capabilities Asael can use',
  'integration' => 'Connected services and accounts',
  _ => 'Choose how Asael should work',
};

IconData _kindIcon(String kind) => switch (kind) {
  'agent' => Icons.smart_toy_outlined,
  'skill' => Icons.auto_awesome_outlined,
  'plugin' => Icons.extension_outlined,
  'project' => Icons.folder_copy_outlined,
  'integration' => Icons.cable_outlined,
  'file' => Icons.description_outlined,
  _ => Icons.explore_outlined,
};
