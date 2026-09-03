import '../automation/automation_module.dart';
import '../integrations/integrations_module.dart';
import '../monitoring/monitoring_module.dart';
import '../quality/quality_module.dart';
import '../security/security_module.dart';
import '../tools/tools_module.dart';
import 'admin_models.dart';
import 'settings_module.dart';

const adminModules = <AdminModule>[
  automationModule,
  integrationsModule,
  toolsModule,
  qualityModule,
  monitoringModule,
  securityModule,
  settingsModule,
];
