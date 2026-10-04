import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/native_workspace_access.dart';
import 'portable_archive_contracts.dart';
import 'portable_archive_controller.dart';
import 'portable_archive_providers.dart';

/// Settings owns its navigation; this panel owns only a fresh private export
/// lifetime. Rendering it never downloads or verifies an archive.
class PortableArchivePanel extends StatefulWidget {
  const PortableArchivePanel({super.key});
  @override
  State<PortableArchivePanel> createState() => _PortableArchivePanelState();
}

class _PortableArchivePanelState extends State<PortableArchivePanel>
    with WidgetsBindingObserver {
  bool _foreground = true;
  Object _visibility = Object();
  PortableArchiveController? _controller;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    _foreground = lifecycle == null || lifecycle == AppLifecycleState.resumed;
  }

  void _close() {
    final controller = _controller;
    _controller = null;
    if (controller != null) {
      controller.invalidate(notify: false);
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
    return KeyedSubtree(
      key: ObjectKey(_visibility),
      child: NativePrivateWorkspace(
        builder: (_) => Consumer(
          builder: (context, ref, _) {
            final controller = ref.watch(
              portableArchiveControllerProvider(_visibility),
            );
            _controller = controller;
            return controller == null
                ? const Padding(
                    padding: EdgeInsets.all(16),
                    child: Text(
                      'Portable archive is unavailable for this session.',
                    ),
                  )
                : PortableArchivePanelView(
                    key: ObjectKey(controller),
                    controller: controller,
                  );
          },
        ),
      ),
    );
  }
}

class PortableArchivePanelView extends StatefulWidget {
  const PortableArchivePanelView({
    super.key,
    required this.controller,
    this.onOpenBrowser,
  });
  final PortableArchiveController controller;
  final VoidCallback? onOpenBrowser;
  @override
  State<PortableArchivePanelView> createState() =>
      _PortableArchivePanelViewState();
}

class _PortableArchivePanelViewState extends State<PortableArchivePanelView> {
  PortableArchiveController get controller => widget.controller;
  VoidCallback? get onOpenBrowser => widget.onOpenBrowser;
  @override
  void didUpdateWidget(covariant PortableArchivePanelView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, controller)) {
      oldWidget.controller.invalidate(notify: false);
    }
  }

  @override
  void dispose() {
    controller.invalidate(notify: false);
    super.dispose();
  }

  bool get _desktop =>
      !kIsWeb &&
      {
        TargetPlatform.macOS,
        TargetPlatform.windows,
        TargetPlatform.linux,
      }.contains(defaultTargetPlatform);
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      final c = controller, theme = Theme.of(context);
      if (!c.available) {
        return Card(
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Text(
              c.authorizationDenied
                  ? 'Portable archive access expired. Sign in again before exporting.'
                  : 'Unlock and sign in to the current workspace to export an archive.',
            ),
          ),
        );
      }
      final desktop = _desktop && c.savingSupported;
      return Card(
        key: ValueKey((c, 'portable-archive-panel')),
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.inventory_2_outlined, size: 24),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      'Portable archive',
                      style: theme.textTheme.titleLarge,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              const Text(
                'Download your archive v2, check its owner and content integrity, then save the exact verified file to a location you choose.',
              ),
              const SizedBox(height: 8),
              const Text(
                'Native limit: 16 MiB. Original attachments are not included.',
              ),
              const SizedBox(height: 16),
              if (desktop) ...[
                FilledButton.icon(
                  key: const Key('portable-archive-save'),
                  onPressed: c.busy ? null : () => unawaited(c.verifyAndSave()),
                  icon: const Icon(Icons.download_outlined),
                  label: const Text('Verify and save archive v2'),
                ),
                const SizedBox(height: 12),
                Semantics(liveRegion: true, child: Text(_status(c.phase))),
                if (c.busy) ...[
                  const SizedBox(height: 10),
                  Semantics(
                    label: _status(c.phase),
                    child: const LinearProgressIndicator(),
                  ),
                ],
                if (c.error != null) ...[
                  const SizedBox(height: 10),
                  Text(
                    c.error!,
                    style: TextStyle(color: theme.colorScheme.error),
                  ),
                ],
                if (c.receipt case final receipt?) ...[
                  const SizedBox(height: 18),
                  _Receipt(receipt: receipt),
                ],
                const SizedBox(height: 12),
                Text(
                  'Saving writes directly to the file you select. A failed write may leave a partial file. Signing out cannot remove a file once writing has begun.',
                  style: theme.textTheme.bodySmall,
                ),
              ] else ...[
                const Text(
                  'Saving archives is available in the desktop app. Open Personal Data in the browser for archive controls.',
                ),
              ],
              const SizedBox(height: 16),
              Align(
                alignment: Alignment.centerLeft,
                child: onOpenBrowser == null
                    ? const NativeWorkspaceBrowserButton(
                        path: '/app/settings',
                        label: 'Open archive controls in browser',
                      )
                    : OutlinedButton.icon(
                        onPressed: () {
                          if (mounted &&
                              identical(c, controller) &&
                              c.available) {
                            onOpenBrowser?.call();
                          }
                        },
                        icon: const Icon(Icons.open_in_browser_outlined),
                        label: const Text('Open archive controls in browser'),
                      ),
              ),
            ],
          ),
        ),
      );
    },
  );
}

String _status(PortableArchivePhase phase) => switch (phase) {
  PortableArchivePhase.idle =>
    'Choose a destination first. Verification runs before any file write.',
  PortableArchivePhase.choosingDestination => 'Choosing a destination…',
  PortableArchivePhase.downloading => 'Downloading the current archive…',
  PortableArchivePhase.verifying => 'Verifying archive integrity locally…',
  PortableArchivePhase.saving => 'Saving the verified bytes…',
  PortableArchivePhase.saved => 'Archive integrity verified and file saved.',
  PortableArchivePhase.canceled =>
    'Destination selection canceled. No archive was downloaded or saved.',
  PortableArchivePhase.failed => 'Archive was not saved successfully.',
  PortableArchivePhase.unavailable =>
    'Native saving is unavailable on this platform.',
};

class _Receipt extends StatelessWidget {
  const _Receipt({required this.receipt});
  final PortableArchiveReceipt receipt;
  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        'Verification receipt',
        style: Theme.of(context).textTheme.titleMedium,
      ),
      const SizedBox(height: 10),
      _Field('Exported', receipt.exportedAt.toUtc().toIso8601String()),
      _Field('Exact file size', '${receipt.byteCount} bytes'),
      _Field(
        'Records',
        '${receipt.includedCount} included · ${_count(receipt.excludedCount)} excluded',
      ),
      _Field('Archive SHA-256', receipt.archiveSha256),
      _Field('Manifest SHA-256', receipt.manifestSha256),
      const Text(
        'These unsigned integrity checks establish the internal consistency of this export. They do not verify a digital signature, restore data or establish a complete historical backup.',
      ),
      const SizedBox(height: 12),
      for (final section in receipt.sections)
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                _sectionName(section.name),
                style: Theme.of(context).textTheme.labelLarge,
              ),
              Text(
                '${section.includedCount} included · ${_count(section.excludedCount)} excluded',
              ),
              Text(_disposition(section.restoreDisposition)),
            ],
          ),
        ),
      if (receipt.exclusions.isNotEmpty) ...[
        const SizedBox(height: 6),
        Text(
          'Declared exclusions',
          style: Theme.of(context).textTheme.titleSmall,
        ),
        const SizedBox(height: 8),
        for (final exclusion in receipt.exclusions)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Text(
              '${_sectionName(exclusion.category)} · ${_count(exclusion.count)}\n${exclusion.reason}',
            ),
          ),
      ],
      const Text(
        'Unknown excluded counts remain unknown; exclusion categories can overlap.',
      ),
    ],
  );
}

String _count(int? value) => value == null ? 'unknown' : '$value';
String _sectionName(String name) => switch (name) {
  'knowledge' => 'Knowledge',
  'memories' => 'Memories',
  'threads' => 'Conversations',
  'today' => 'Today',
  'projects' => 'Projects',
  'connections' => 'Connections',
  'skills' => 'Skills',
  'agents' => 'Agents',
  'assets' => 'Original attachments',
  _ => name,
};
String _disposition(String value) => switch (value) {
  'restore' => 'Declared portable content; restore is a separate action.',
  'reauthorization_required' => 'Reauthorization required.',
  'not_included' => 'Not included.',
  _ => value,
};

class _Field extends StatelessWidget {
  const _Field(this.label, this.value);
  final String label, value;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: Theme.of(context).textTheme.labelMedium),
        const SizedBox(height: 4),
        SelectableText(value),
      ],
    ),
  );
}
