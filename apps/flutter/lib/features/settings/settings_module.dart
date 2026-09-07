import 'package:flutter/material.dart';

import '../../generated/native_contract.g.dart';
import 'admin_models.dart';

const settingsModule = AdminModule(
  id: 'settings',
  label: 'Workspace',
  icon: Icons.tune_rounded,
  description: 'Readiness, identity, migrations, and portable data controls.',
  endpoints: [
    AdminEndpoint('Workspace readiness', NativePaths.adminWorkspaceReadiness),
    AdminEndpoint('Workspace summary', NativePaths.workspaceSummary),
    AdminEndpoint('Control plane identity', NativePaths.adminAuthControlPlane),
    AdminEndpoint('Schema migrations', NativePaths.adminSystemMigrations),
    AdminEndpoint('Portable data export', NativePaths.adminDataExport),
  ],
);
