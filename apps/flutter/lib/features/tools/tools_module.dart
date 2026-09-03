import 'package:flutter/material.dart';

import '../settings/admin_models.dart';

const toolsModule = AdminModule(
  id: 'tools',
  label: 'Governed tools',
  icon: Icons.build_circle_outlined,
  description: 'Capabilities, skills, policy, and approval-aware execution.',
  endpoints: [
    AdminEndpoint('Tool registry', '/api/tools'),
    AdminEndpoint('Capabilities', '/api/capabilities'),
    AdminEndpoint('Skills', '/api/skills'),
    AdminEndpoint('Trust policy', '/api/trust'),
  ],
);
