import 'package:flutter/material.dart';

import '../../generated/native_contract.g.dart';
import '../settings/admin_models.dart';

const integrationsModule = AdminModule(
  id: 'integrations',
  label: 'Connections',
  icon: Icons.cable_rounded,
  description:
      'Accounts and external services Asael may read from or act in. Every connection keeps its own credentials and permissions.',
  endpoints: [
    AdminEndpoint(
      'Accounts and personal sources',
      NativePaths.adminOauth,
      description: 'OAuth accounts such as Google Workspace',
    ),
    AdminEndpoint(
      'External MCP servers',
      NativePaths.adminConnectors,
      description: 'Servers that supply reviewed tools and resources to Asael',
    ),
    AdminEndpoint(
      'REST APIs',
      NativePaths.adminOpenapiConnectors,
      description: 'OpenAPI services imported as governed tools',
    ),
    AdminEndpoint(
      'Connection library',
      NativePaths.adminConnectionCatalog,
      description: 'Available connection templates',
    ),
  ],
);
