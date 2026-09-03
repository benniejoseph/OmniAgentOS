import 'package:flutter/material.dart';

import '../settings/admin_models.dart';

const automationModule = AdminModule(
  id: 'automation',
  label: 'Automation',
  icon: Icons.account_tree_outlined,
  description: 'Workflows, triggers, executions, and worker operations.',
  endpoints: [
    AdminEndpoint(
      'Workflows',
      '/api/workflows',
      description: 'Versioned automation plans',
    ),
    AdminEndpoint(
      'Triggers',
      '/api/triggers',
      description: 'Schedules and event rules',
    ),
    AdminEndpoint(
      'Operations',
      '/api/operations',
      description: 'Background execution health',
    ),
  ],
  actions: [AdminAction('Process due workflows', '/api/workflows/tick')],
);
