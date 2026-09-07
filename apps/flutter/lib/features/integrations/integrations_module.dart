import 'package:flutter/material.dart';

import '../../generated/native_contract.g.dart';
import '../settings/admin_models.dart';

const integrationsModule = AdminModule(
  id: 'integrations',
  label: 'Integrations',
  icon: Icons.cable_rounded,
  description: 'OAuth connections, MCP services, and OpenAPI connectors.',
  endpoints: [
    AdminEndpoint('Connection catalog', NativePaths.adminConnectionCatalog),
    AdminEndpoint('Connected services', NativePaths.adminConnectors),
    AdminEndpoint('OAuth providers', NativePaths.adminOauth),
    AdminEndpoint('OpenAPI connectors', NativePaths.adminOpenapiConnectors),
  ],
);
