import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/network/native_workspace_access.dart';
import '../monitoring/monitoring_workspace_view.dart';
import '../quality/quality_workspace_view.dart';
import 'model_settings_view.dart';

/// Maintenance pages retain their own manager authorization and visibility
/// lifecycle. Opening Settings does not mount either operational controller.
class SettingsWorkspacePage extends StatelessWidget {
  const SettingsWorkspacePage({super.key, this.section});

  final String? section;

  @override
  Widget build(BuildContext context) {
    if (section != 'quality' && section != 'monitoring') {
      return NativePrivateWorkspace(
        ownNavigator: true,
        builder: (access) =>
            ModelSettingsView(api: access.api, authority: access.authority),
      );
    }

    final scheme = Theme.of(context).colorScheme;
    return Column(
      children: [
        Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: scheme.surface,
            border: Border(bottom: BorderSide(color: scheme.outlineVariant)),
          ),
          child: Wrap(
            spacing: 8,
            runSpacing: 4,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              TextButton.icon(
                onPressed: () => context.go('/settings'),
                icon: const Icon(Icons.arrow_back_rounded, size: 18),
                label: const Text('Settings'),
              ),
              for (final item in const [
                (id: 'quality', label: 'Quality Checks'),
                (id: 'monitoring', label: 'Monitoring'),
              ])
                Semantics(
                  selected: section == item.id,
                  child: TextButton(
                    onPressed: () => context.go('/settings?section=${item.id}'),
                    style: TextButton.styleFrom(
                      backgroundColor: section == item.id
                          ? scheme.secondaryContainer
                          : null,
                      foregroundColor: section == item.id
                          ? scheme.onSecondaryContainer
                          : null,
                    ),
                    child: Text(item.label),
                  ),
                ),
            ],
          ),
        ),
        Expanded(
          child: section == 'quality'
              ? const NativeQualityPage()
              : const NativeMonitoringPage(),
        ),
      ],
    );
  }
}
