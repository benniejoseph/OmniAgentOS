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

  List<_ComposerChoice> get choices {
    final current = trigger;
    if (current == null) return const [];
    final query = current.query.toLowerCase();
    bool matches(String label, String description) =>
        query.isEmpty ||
        label.toLowerCase().contains(query) ||
        description.toLowerCase().contains(query);
    final selectedKeys = widget.selected.map((item) => item.key).toSet();
    final result = <_ComposerChoice>[];
    if (current.symbol == '/') {
      const approaches = <_ComposerChoice>[
        _ComposerChoice.approach('orchestrate', 'General', 'Let Asael choose the best approach.'),
        _ComposerChoice.approach('research', 'Research', 'Use current sources and preserve citations.'),
        _ComposerChoice.approach('execute', 'Act', 'Use connected services through governed actions.'),
        _ComposerChoice.approach('learn', 'Learn', 'Explain, organize, and form useful knowledge.'),
      ];
      result.addAll(
        approaches.where((item) => matches(item.label, item.description)),
      );
    }
    for (final item in catalog?.items ?? const <TalkCommandContextReference>[]) {
      if (!item.selectable || selectedKeys.contains(item.key)) continue;
      if (current.symbol == '/' && item.kind != 'skill') continue;
      if (!matches(item.label, '${_kindLabel(item.kind)} ${item.description}')) {
        continue;
      }
      result.add(_ComposerChoice.reference(item));
      if (result.length >= 16) break;
    }
    return result;
  }

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
    final next = '${value.substring(0, current.start)}${value.substring(current.end)}'
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

  @override
  Widget build(BuildContext context) {
    final items = choices;
    final safeIndex = items.isEmpty ? 0 : activeIndex.clamp(0, items.length - 1);
    return Focus(
      onKeyEvent: _handleKey,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (trigger != null)
            Container(
              constraints: const BoxConstraints(maxHeight: 260),
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
                        CircleAvatar(
                          radius: 14,
                          child: Text(trigger!.symbol),
                        ),
                        const SizedBox(width: 9),
                        Expanded(
                          child: Text(
                            trigger!.symbol == '/'
                                ? 'Use a Skill or choose an approach'
                                : 'Add exact context',
                            style: Theme.of(context).textTheme.labelLarge,
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
                  if (catalogError != null)
                    const Padding(
                      padding: EdgeInsets.all(14),
                      child: Text('Context is temporarily unavailable.'),
                    )
                  else if (!loading && items.isEmpty)
                    const Padding(
                      padding: EdgeInsets.all(14),
                      child: Text('No matching Skills or context.'),
                    )
                  else
                    Flexible(
                      child: ListView.builder(
                        shrinkWrap: true,
                        padding: const EdgeInsets.all(6),
                        itemCount: items.length,
                        itemBuilder: (context, index) {
                          final item = items[index];
                          return ListTile(
                            dense: true,
                            selected: index == safeIndex,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(12),
                            ),
                            leading: Icon(_kindIcon(item.kind)),
                            title: Text(item.label),
                            subtitle: Text(
                              item.description,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            trailing: Text(_kindLabel(item.kind)),
                            onTap: () => _choose(item),
                          );
                        },
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
              helperText: '/ Skills · @ files, Agents, Projects, Extensions, Connections',
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
  const _ComposerChoice.approach(
    this.approach,
    this.label,
    this.description,
  ) : reference = null,
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

_ComposerTrigger? _triggerAtSelection(TextEditingController controller) {
  final selection = controller.selection;
  final caret = selection.isValid ? selection.extentOffset : controller.text.length;
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

IconData _kindIcon(String kind) => switch (kind) {
  'agent' => Icons.smart_toy_outlined,
  'skill' => Icons.auto_awesome_outlined,
  'plugin' => Icons.extension_outlined,
  'project' => Icons.folder_copy_outlined,
  'integration' => Icons.cable_outlined,
  'file' => Icons.description_outlined,
  _ => Icons.explore_outlined,
};
