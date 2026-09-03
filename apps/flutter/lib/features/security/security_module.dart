import 'package:flutter/material.dart';

import '../settings/admin_models.dart';

const securityModule = AdminModule(
  id: 'security',
  label: 'Security',
  icon: Icons.security_rounded,
  description: 'Audit trails, tenant isolation, retention, and access context.',
  endpoints: [
    AdminEndpoint('Audit trail', '/api/security/audits'),
    AdminEndpoint('Isolation report', '/api/security/isolation-report'),
    AdminEndpoint('Retention', '/api/security/retention'),
    AdminEndpoint('Security context', '/api/security/context'),
  ],
);
