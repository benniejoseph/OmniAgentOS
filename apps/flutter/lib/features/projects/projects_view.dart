import 'package:flutter/material.dart';

import '../../core/network/api_client.dart';
import 'project_workspaces.dart';
import 'projects.dart';

class ProjectsView extends StatelessWidget {
  const ProjectsView({
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
  );
}

class ProjectDetailView extends StatelessWidget {
  const ProjectDetailView({
    super.key,
    required this.id,
    required this.repository,
    required this.api,
    this.focusWorkItemId,
    this.initiallyBuild = false,
    this.focusArtifactId,
    this.onBuilderLocationChanged,
    this.onInspectResult,
  });
  final String id;
  final ProjectsRepository repository;
  final ApiClient api;
  final String? focusWorkItemId, focusArtifactId;
  final bool initiallyBuild;
  final void Function(bool, String?)? onBuilderLocationChanged;
  final ValueChanged<String>? onInspectResult;
  @override
  Widget build(BuildContext context) => ProjectDocumentWorkspace(
    id: id,
    repository: repository,
    api: api,
    focusWorkItemId: focusWorkItemId,
    initiallyBuild: initiallyBuild,
    focusArtifactId: focusArtifactId,
    onBuilderLocationChanged: onBuilderLocationChanged,
    onInspectResult: onInspectResult,
  );
}
