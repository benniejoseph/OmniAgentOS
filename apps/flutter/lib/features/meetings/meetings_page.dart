import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'meetings.dart';
import 'meetings_providers.dart';
import 'meetings_view.dart';

class NativeMeetingsPage extends ConsumerWidget {
  const NativeMeetingsPage({
    super.key,
    required this.onOpen,
    this.desktop = false,
    this.active = true,
  });
  final ValueChanged<Meeting> onOpen;
  final bool desktop, active;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final controller = ref.watch(meetingsControllerProvider);
    return MeetingsView(
      key: ObjectKey(controller),
      controller: controller,
      actions: ref.watch(meetingActionControllerProvider('new')),
      calendar: ref.watch(meetingCalendarControllerProvider),
      onOpen: onOpen,
      desktop: desktop,
      active: active,
    );
  }
}

class NativeMeetingDetailPage extends ConsumerWidget {
  const NativeMeetingDetailPage({
    super.key,
    required this.id,
    this.workspaceId,
    this.desktop = false,
    this.active = true,
  });
  final String id;
  final String? workspaceId;
  final bool desktop, active;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final repository = ref.watch(meetingsRepositoryProvider);
    return MeetingDetailView(
      key: ObjectKey(repository),
      id: id,
      workspaceId: workspaceId,
      repository: repository,
      actions: ref.watch(meetingActionControllerProvider(id)),
      desktop: desktop,
      active: active,
    );
  }
}
