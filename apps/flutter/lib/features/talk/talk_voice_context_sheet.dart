import 'package:flutter/material.dart';

import '../../app/mobile/mobile_flow_scaffold.dart';
import '../../app/mobile/mobile_page_scaffold.dart';
import 'talk_command_context.dart';

typedef VoiceContextSelection = ({
  List<TalkCommandContextReference> references,
  String? computerUseTarget,
});

enum VoiceContextDevice {
  mac('local_macos', 'This Mac'),
  phone('local_android', 'This phone');

  const VoiceContextDevice(this.apiValue, this.label);
  final String apiValue;
  final String label;
}

class VoiceContextEditor extends StatefulWidget {
  const VoiceContextEditor({
    super.key,
    required this.loadCatalog,
    required this.selected,
    required this.computerUseTarget,
    required this.deviceReady,
    required this.deviceStatus,
    required this.current,
    required this.guard,
    this.device,
    this.onDeviceSettings,
  });
  final Future<TalkCommandContextCatalog> Function() loadCatalog;
  final List<TalkCommandContextReference> selected;
  final String? computerUseTarget;
  final VoiceContextDevice? device;
  final bool Function() deviceReady;
  final String Function() deviceStatus;
  final VoidCallback? onDeviceSettings;
  final bool Function() current;
  final Listenable guard;
  @override
  State<VoiceContextEditor> createState() => _VoiceContextEditorState();
}

class _VoiceContextEditorState extends State<VoiceContextEditor> {
  late Future<TalkCommandContextCatalog> _catalog = widget.loadCatalog();
  late final _selected = {for (final item in widget.selected) item.key: item};
  late String? _computerUseTarget = widget.computerUseTarget;
  String _query = '';

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.guard,
    builder: (context, _) => Dialog.fullscreen(
      child: MobileFlowScaffold(
        title: 'Voice context',
        scrollBody: false,
        footer: FilledButton.icon(
          onPressed: !widget.current()
              ? null
              : () {
                  if (!widget.current()) return;
                  Navigator.of(context).pop<VoiceContextSelection>((
                    references: List.unmodifiable(_selected.values),
                    computerUseTarget: _computerUseTarget,
                  ));
                },
          icon: const Icon(Icons.check_rounded),
          label: const Text('Use this context'),
        ),
        child: !widget.current()
            ? const Center(
                child: Text(
                  'This workspace changed. Close and reopen voice options.',
                ),
              )
            : Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text(
                    'Choose sources for your next call. Your conversation and saved personal context stay available.',
                  ),
                  const SizedBox(height: 16),
                  if (widget.device case final device?)
                    MobileSurface(
                      padding: EdgeInsets.zero,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          SwitchListTile.adaptive(
                            title: Text('Asael + ${device.label}'),
                            subtitle: Text(widget.deviceStatus()),
                            value: _computerUseTarget == device.apiValue,
                            onChanged:
                                !widget.deviceReady() &&
                                    _computerUseTarget != device.apiValue
                                ? null
                                : (value) {
                                    if (!widget.current() ||
                                        (value && !widget.deviceReady())) {
                                      return;
                                    }
                                    setState(
                                      () => _computerUseTarget = value
                                          ? device.apiValue
                                          : null,
                                    );
                                  },
                          ),
                          if (widget.onDeviceSettings != null &&
                              !widget.deviceReady())
                            Align(
                              alignment: Alignment.centerLeft,
                              child: TextButton.icon(
                                onPressed: () {
                                  if (widget.current()) {
                                    widget.onDeviceSettings!();
                                  }
                                },
                                icon: const Icon(Icons.settings_outlined),
                                label: Text('Set up ${device.label}'),
                              ),
                            ),
                          const Padding(
                            padding: EdgeInsets.fromLTRB(16, 0, 16, 12),
                            child: Text(
                              'Your selection stays with the call. Actions that need your approval will still ask for it.',
                            ),
                          ),
                        ],
                      ),
                    ),
                  const SizedBox(height: 16),
                  TextField(
                    onChanged: (value) =>
                        setState(() => _query = value.trim().toLowerCase()),
                    decoration: const InputDecoration(
                      prefixIcon: Icon(Icons.search_rounded),
                      hintText: 'Find a source or project',
                    ),
                  ),
                  const SizedBox(height: 12),
                  Expanded(
                    child: FutureBuilder<TalkCommandContextCatalog>(
                      future: _catalog,
                      builder: (context, snapshot) {
                        if (!widget.current()) return const SizedBox.shrink();
                        if (snapshot.connectionState != ConnectionState.done) {
                          return const Center(
                            child: CircularProgressIndicator(),
                          );
                        }
                        if (snapshot.hasError) {
                          return Center(
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                const Text(
                                  'Sources couldn’t load. Your current selection is kept.',
                                ),
                                const SizedBox(height: 12),
                                OutlinedButton.icon(
                                  onPressed: () => setState(
                                    () => _catalog = widget.loadCatalog(),
                                  ),
                                  icon: const Icon(Icons.refresh_rounded),
                                  label: const Text('Try again'),
                                ),
                              ],
                            ),
                          );
                        }
                        final all =
                            snapshot.data?.items ??
                            const <TalkCommandContextReference>[];
                        final byKey = {for (final item in all) item.key: item};
                        final rows = all
                            .where(
                              (item) =>
                                  item.kind != 'agent' &&
                                  '${item.label} ${item.description}'
                                      .toLowerCase()
                                      .contains(_query),
                            )
                            .toList();
                        final missing = _selected.values
                            .where(
                              (item) =>
                                  item.kind != 'agent' &&
                                  !byKey.containsKey(item.key),
                            )
                            .toList();
                        return ListView(
                          children: [
                            if (_selected.isNotEmpty)
                              Padding(
                                padding: const EdgeInsets.only(bottom: 12),
                                child: Wrap(
                                  spacing: 6,
                                  runSpacing: 6,
                                  children: [
                                    for (final item in _selected.values.where(
                                      (item) => item.kind != 'agent',
                                    ))
                                      InputChip(
                                        label: Text(
                                          byKey[item.key]?.label ??
                                              'Saved ${_kind(item.kind).toLowerCase()}',
                                        ),
                                        onDeleted: () {
                                          if (widget.current()) {
                                            setState(
                                              () => _selected.remove(item.key),
                                            );
                                          }
                                        },
                                      ),
                                  ],
                                ),
                              ),
                            if (missing.isNotEmpty)
                              const Padding(
                                padding: EdgeInsets.only(bottom: 12),
                                child: Text(
                                  'Some saved sources are unavailable in this list. They remain selected until you remove them.',
                                ),
                              ),
                            if (rows.isEmpty)
                              const Padding(
                                padding: EdgeInsets.symmetric(vertical: 24),
                                child: Text(
                                  'No sources match. Try another name.',
                                ),
                              ),
                            for (final item in rows)
                              CheckboxListTile(
                                contentPadding: EdgeInsets.zero,
                                controlAffinity:
                                    ListTileControlAffinity.leading,
                                value: _selected.containsKey(item.key),
                                title: Text(item.label),
                                subtitle: Text(_kind(item.kind)),
                                onChanged: !item.selectable
                                    ? null
                                    : (value) {
                                        if (!widget.current()) return;
                                        setState(() {
                                          if (value != true) {
                                            _selected.remove(item.key);
                                            return;
                                          }
                                          if (item.kind == 'project') {
                                            _selected.removeWhere(
                                              (_, existing) =>
                                                  existing.kind == 'project',
                                            );
                                          }
                                          _selected[item.key] = item;
                                        });
                                      },
                              ),
                          ],
                        );
                      },
                    ),
                  ),
                ],
              ),
      ),
    ),
  );
}

String _kind(String value) => switch (value) {
  'project' => 'Project',
  'file' => 'Saved source',
  'skill' => 'Skill',
  'plugin' => 'Plugin',
  'integration' => 'Connection',
  _ => 'Context',
};
