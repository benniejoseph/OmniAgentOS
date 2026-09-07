import 'package:flutter/material.dart';

import '../../generated/native_contract.g.dart';
import '../settings/admin_models.dart';

const toolsModule = AdminModule(
  id: 'tools',
  label: 'Governed tools',
  icon: Icons.build_circle_outlined,
  description: 'Capabilities, skills, policy, and approval-aware execution.',
  endpoints: [
    AdminEndpoint('Tool registry', NativePaths.adminTools),
    AdminEndpoint('Capabilities', NativePaths.adminCapabilities),
    AdminEndpoint('Skills', NativePaths.skillsList),
    AdminEndpoint('Trust policy', NativePaths.adminTrust),
  ],
);
