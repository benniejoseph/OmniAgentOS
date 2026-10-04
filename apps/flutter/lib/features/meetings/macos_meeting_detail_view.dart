import 'package:flutter/material.dart';

import 'meetings.dart';
import 'meetings_view.dart';

class MacosMeetingDetailView extends StatelessWidget {
  const MacosMeetingDetailView({
    super.key,
    required this.id,
    required this.repository,
    this.workspaceId,
    this.active = true,
  });
  final String id;
  final String? workspaceId;
  final MeetingsRepository repository;
  final bool active;
  @override
  Widget build(BuildContext context) => MeetingDetailView(
    id: id,
    workspaceId: workspaceId,
    repository: repository,
    desktop: true,
    active: active,
  );
}
