import 'package:flutter/material.dart';

import '../settings/admin_models.dart';

const monitoringModule = AdminModule(
  id: 'monitoring',
  label: 'Monitoring',
  icon: Icons.monitor_heart_outlined,
  description: 'Service health, SLOs, incidents, alerts, and telemetry.',
  endpoints: [
    AdminEndpoint('Service health', '/api/health'),
    AdminEndpoint('Observability', '/api/observability'),
    AdminEndpoint('SLO policy', '/api/observability/slo'),
    AdminEndpoint('Incidents', '/api/incidents'),
    AdminEndpoint('Alerts', '/api/alerts'),
  ],
);
