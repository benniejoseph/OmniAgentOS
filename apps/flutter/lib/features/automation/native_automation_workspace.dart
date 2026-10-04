import 'package:flutter/material.dart';

import '../../app/platform/macos_presentation.dart';
import '../agents/specialist_workspace.dart';
import 'automation_studio_view.dart';
import 'macos_automation_studio_view.dart';

class NativeAutomationWorkspace extends StatefulWidget {
  const NativeAutomationWorkspace({super.key, this.initialSection});
  final String? initialSection;

  @override
  State<NativeAutomationWorkspace> createState() =>
      _NativeAutomationWorkspaceState();
}

class _NativeAutomationWorkspaceState extends State<NativeAutomationWorkspace> {
  // Keep only navigation state above the protected workspace. Its inventory,
  // editors, and history dialogs still leave with the guarded subtree.
  late String? _section = widget.initialSection;

  @override
  void didUpdateWidget(covariant NativeAutomationWorkspace oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.initialSection != widget.initialSection) {
      _section = widget.initialSection;
    }
  }

  void _selectSection(String section) => setState(() => _section = section);

  @override
  Widget build(BuildContext context) => SpecialistWorkspace(
    family: 'automation',
    browserPath: '/app/automation',
    requireManager: true,
    builder: (_) => usesMacosPresentation()
        ? MacosAutomationStudioView(
            initialSection: _section,
            onSectionChanged: _selectSection,
          )
        : AutomationStudioView(
            initialSection: _section,
            onSectionChanged: _selectSection,
          ),
  );
}
