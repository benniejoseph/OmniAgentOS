import 'package:flutter/material.dart';

import '../../generated/native_contract.g.dart';
import '../settings/admin_models.dart';

const automationModule = AdminModule(
  id: 'automation',
  label: 'Automation',
  icon: Icons.account_tree_outlined,
  description: 'Workflows, triggers, executions, and worker operations.',
  endpoints: [
    AdminEndpoint(
      'Workflows',
      NativePaths.adminWorkflows,
      description: 'Versioned automation plans',
    ),
    AdminEndpoint(
      'Triggers',
      NativePaths.adminTriggers,
      description: 'Schedules and event rules',
    ),
    AdminEndpoint(
      'Operations',
      NativePaths.adminOperations,
      description: 'Background execution health',
    ),
  ],
  actions: [AdminAction('Process due workflows', NativePaths.adminWorkflowsTick)],
);
