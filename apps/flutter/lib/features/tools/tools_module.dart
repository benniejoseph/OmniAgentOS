import 'package:flutter/material.dart';

import '../../generated/native_contract.g.dart';
import '../settings/admin_models.dart';

const toolsModule = AdminModule(
  id: 'tools',
  label: 'Capabilities',
  icon: Icons.build_circle_outlined,
  description:
      'Skills teach agents how to work. Tools are the individual governed actions they may request.',
  endpoints: [
    AdminEndpoint(
      'Skills',
      NativePaths.skillsList,
      description: 'Reusable instructions assigned to agents',
    ),
    AdminEndpoint(
      'Effective capabilities',
      NativePaths.adminCapabilities,
      description: 'What the current agent runtime can discover',
    ),
    AdminEndpoint(
      'Advanced tool audit',
      NativePaths.adminTools,
      description: 'Atomic actions, risk levels, and approval posture',
    ),
    AdminEndpoint(
      'Trust policy',
      NativePaths.adminTrust,
      description: 'Approval and repeated-execution policy',
    ),
  ],
);
