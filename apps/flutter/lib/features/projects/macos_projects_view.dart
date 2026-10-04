import 'package:flutter/material.dart';

import 'project_workspaces.dart';
import 'projects.dart';

class MacosProjectsView extends StatelessWidget {
  const MacosProjectsView({
    super.key,
    required this.controller,
    required this.onOpen,
    this.onOpenResponsibilities,
  });
  final ProjectsController controller;
  final ValueChanged<Project> onOpen;
  final VoidCallback? onOpenResponsibilities;
  @override
  Widget build(BuildContext context) => ProjectCollectionWorkspace(
    controller: controller,
    onOpen: onOpen,
    onOpenResponsibilities: onOpenResponsibilities,
    desktop: true,
  );
}
