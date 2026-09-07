import 'package:flutter/material.dart';

import '../../generated/native_contract.g.dart';
import '../settings/admin_models.dart';

const securityModule = AdminModule(
  id: 'security',
  label: 'Security',
  icon: Icons.security_rounded,
  description: 'Audit trails, tenant isolation, retention, and access context.',
  endpoints: [
    AdminEndpoint('Audit trail', NativePaths.adminSecurityAudits),
    AdminEndpoint('Isolation report', NativePaths.adminSecurityIsolation),
    AdminEndpoint('Retention', NativePaths.adminSecurityRetention),
    AdminEndpoint('Security context', NativePaths.adminSecurityContext),
  ],
);
