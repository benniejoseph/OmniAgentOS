import 'package:flutter/material.dart';

import '../settings/admin_models.dart';

const integrationsModule = AdminModule(
  id: 'integrations',
  label: 'Integrations',
  icon: Icons.cable_rounded,
  description: 'OAuth connections, MCP services, and OpenAPI connectors.',
  endpoints: [
    AdminEndpoint('Connection catalog', '/api/connection-catalog'),
    AdminEndpoint('Connected services', '/api/connectors'),
    AdminEndpoint('OAuth providers', '/api/oauth'),
    AdminEndpoint('OpenAPI connectors', '/api/openapi-connectors'),
  ],
);
