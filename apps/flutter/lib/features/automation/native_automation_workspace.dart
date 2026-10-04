import 'package:flutter/material.dart';

import '../../app/platform/macos_presentation.dart';
import '../agents/specialist_workspace.dart';
import 'automation_studio_view.dart';
import 'macos_automation_studio_view.dart';

class NativeAutomationWorkspace extends StatelessWidget {
  const NativeAutomationWorkspace({super.key, this.initialSection});
  final String? initialSection;
  @override
  Widget build(BuildContext context) => SpecialistWorkspace(
    family: 'automation',
    browserPath: '/app/automation',
    requireManager: true,
    builder: (_) => usesMacosPresentation()
        ? MacosAutomationStudioView(initialSection: initialSection)
        : AutomationStudioView(initialSection: initialSection),
  );
}
