import 'package:flutter/material.dart';

import 'admin_models.dart';

const settingsModule = AdminModule(
  id: 'settings',
  label: 'Workspace',
  icon: Icons.tune_rounded,
  description: 'Readiness, identity, migrations, and portable data controls.',
  endpoints: [
    AdminEndpoint('Workspace readiness', '/api/workspace-readiness'),
    AdminEndpoint('Workspace summary', '/api/workspace-summary'),
    AdminEndpoint('Control plane identity', '/api/auth/control-plane'),
    AdminEndpoint('Schema migrations', '/api/system/migrations'),
    AdminEndpoint('Portable data export', '/api/data/export'),
  ],
);
