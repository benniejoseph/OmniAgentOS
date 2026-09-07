import 'package:flutter/material.dart';

import '../../generated/native_contract.g.dart';
import '../settings/admin_models.dart';

const monitoringModule = AdminModule(
  id: 'monitoring',
  label: 'Monitoring',
  icon: Icons.monitor_heart_outlined,
  description: 'Service health, SLOs, incidents, alerts, and telemetry.',
  endpoints: [
    AdminEndpoint('Service health', NativePaths.adminHealth),
    AdminEndpoint('Observability', NativePaths.adminObservability),
    AdminEndpoint('SLO policy', NativePaths.adminSlo),
    AdminEndpoint('Incidents', NativePaths.adminIncidents),
    AdminEndpoint('Alerts', NativePaths.adminAlerts),
  ],
);
