import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/platform/macos_presentation.dart';
import 'agent_control_view.dart';
import 'agents.dart';
import 'agents_providers.dart';
import 'macos_agents_view.dart';
import 'specialist_workspace.dart';

class NativeAgentsWorkspace extends StatelessWidget {
  const NativeAgentsWorkspace({super.key, this.onAssignWork});
  final ValueChanged<AgentProfile>? onAssignWork;
  @override
  Widget build(BuildContext context) => SpecialistWorkspace(
    family: 'agents',
    browserPath: '/app/agents',
    builder: (_) => Consumer(
      builder: (context, ref, _) {
        final controller = ref.watch(agentsControllerProvider),
            council = ref.watch(agentCouncilControllerProvider);
        return usesMacosPresentation()
            ? MacosAgentsView(
                controller: controller,
                councilController: council,
                onAssignWork: onAssignWork,
              )
            : AgentsView(
                controller: controller,
                liveWork: AgentControlView(controller: council),
                onRefreshLiveWork: council.refresh,
              );
      },
    ),
  );
}
