import 'package:flutter/material.dart';

import 'meetings.dart';
import 'meetings_view.dart';

class MacosMeetingsView extends StatelessWidget {
  const MacosMeetingsView({
    super.key,
    required this.controller,
    required this.onOpen,
    this.active = true,
  });
  final MeetingsController controller;
  final ValueChanged<Meeting> onOpen;
  final bool active;
  @override
  Widget build(BuildContext context) => MeetingsView(
    controller: controller,
    onOpen: onOpen,
    desktop: true,
    active: active,
  );
}
