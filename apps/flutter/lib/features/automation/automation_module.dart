import 'package:flutter/material.dart';

import '../../generated/native_contract.g.dart';
import '../settings/admin_models.dart';

const automationModule = AdminModule(
  id: 'automation',
  label: 'Automations',
  icon: Icons.account_tree_outlined,
  description:
      'Repeatable work and the schedules or events that start it. Advanced queue controls stay available for recovery.',
  endpoints: [
    AdminEndpoint(
      'Runs',
      NativePaths.adminWorkflows,
      description: 'Current and recent automation runs',
    ),
    AdminEndpoint(
      'Schedules and triggers',
      NativePaths.adminTriggers,
      description: 'Time-based and event-based starting rules',
    ),
    AdminEndpoint(
      'Advanced operations',
      NativePaths.adminOperations,
      description: 'Queue, retry, lease, and recovery health',
    ),
  ],
  actions: [],
);
