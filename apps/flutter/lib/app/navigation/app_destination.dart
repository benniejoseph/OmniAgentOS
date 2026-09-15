import 'package:flutter/material.dart';

enum AppDestinationGroup { workspace, automation, review, system }

class AppDestination {
  const AppDestination({
    required this.label,
    required this.path,
    required this.icon,
    required this.selectedIcon,
    required this.eyebrow,
    required this.description,
    required this.group,
    this.primary = false,
  });

  final String label;
  final String path;
  final IconData icon;
  final IconData selectedIcon;
  final String eyebrow;
  final String description;
  final AppDestinationGroup group;
  final bool primary;
}

const appDestinations = <AppDestination>[
  AppDestination(
    label: 'Today',
    path: '/today',
    icon: Icons.grid_view_outlined,
    selectedIcon: Icons.grid_view_rounded,
    eyebrow: 'YOUR DAYBOOK',
    description: 'Your work, decisions, and recent results.',
    group: AppDestinationGroup.workspace,
    primary: true,
  ),
  AppDestination(
    label: 'Command',
    path: '/talk',
    icon: Icons.graphic_eq_rounded,
    selectedIcon: Icons.multitrack_audio_rounded,
    eyebrow: 'ASK OR DELEGATE',
    description: 'Ask Asael a question or hand off a task.',
    group: AppDestinationGroup.workspace,
    primary: true,
  ),
  AppDestination(
    label: 'Capture',
    path: '/capture',
    icon: Icons.add_circle_outline_rounded,
    selectedIcon: Icons.add_circle_rounded,
    eyebrow: 'SECOND BRAIN',
    description: 'Save a note or file to your second brain.',
    group: AppDestinationGroup.workspace,
    primary: true,
  ),
  AppDestination(
    label: 'Projects',
    path: '/projects',
    icon: Icons.folder_copy_outlined,
    selectedIcon: Icons.folder_copy_rounded,
    eyebrow: 'DURABLE WORK',
    description: 'Plan, execute, review, and verify durable work.',
    group: AppDestinationGroup.workspace,
    primary: true,
  ),
  AppDestination(
    label: 'Memory',
    path: '/knowledge',
    icon: Icons.account_tree_outlined,
    selectedIcon: Icons.account_tree_rounded,
    eyebrow: 'DURABLE CONTEXT',
    description: 'What your second brain knows and remembers.',
    group: AppDestinationGroup.workspace,
    primary: true,
  ),
  AppDestination(
    label: 'Arsenal',
    path: '/agents',
    icon: Icons.hub_outlined,
    selectedIcon: Icons.hub_rounded,
    eyebrow: 'AGENT ARSENAL',
    description: 'Your specialists, capabilities, and adaptation lifecycle.',
    group: AppDestinationGroup.workspace,
  ),
  AppDestination(
    label: 'Meetings',
    path: '/meetings',
    icon: Icons.groups_2_outlined,
    selectedIcon: Icons.groups_2_rounded,
    eyebrow: 'DECISION MEMORY',
    description: 'Calendar context, consent, decisions, and follow-through.',
    group: AppDestinationGroup.workspace,
  ),
  AppDestination(
    label: 'Accounts',
    path: '/accounts',
    icon: Icons.business_outlined,
    selectedIcon: Icons.business_rounded,
    eyebrow: 'CUSTOMER 360',
    description: 'Customer health, evidence, risks, and renewal context.',
    group: AppDestinationGroup.workspace,
  ),
  AppDestination(
    label: 'Markets',
    path: '/markets',
    icon: Icons.candlestick_chart_outlined,
    selectedIcon: Icons.candlestick_chart_rounded,
    eyebrow: 'MARKET INTELLIGENCE',
    description: 'Evidence-bound news, price structure, and ICT analysis.',
    group: AppDestinationGroup.workspace,
  ),
  AppDestination(
    label: 'Workflows',
    path: '/workflows',
    icon: Icons.account_tree_outlined,
    selectedIcon: Icons.account_tree_rounded,
    eyebrow: 'AUTOMATION',
    description: 'Background work, triggers, retries, and approvals.',
    group: AppDestinationGroup.automation,
  ),
  AppDestination(
    label: 'Integrations',
    path: '/integrations',
    icon: Icons.cable_outlined,
    selectedIcon: Icons.cable_rounded,
    eyebrow: 'CONNECTED SERVICES',
    description: 'OAuth, MCP, and API connections Asael may use.',
    group: AppDestinationGroup.automation,
  ),
  AppDestination(
    label: 'Tools',
    path: '/tools',
    icon: Icons.build_outlined,
    selectedIcon: Icons.build_rounded,
    eyebrow: 'GOVERNED CAPABILITIES',
    description: 'Agent tools, skills, risk levels, and policy.',
    group: AppDestinationGroup.automation,
  ),
  AppDestination(
    label: 'Inbox',
    path: '/inbox',
    icon: Icons.inbox_outlined,
    selectedIcon: Icons.inbox_rounded,
    eyebrow: 'ATTENTION QUEUE',
    description: 'Review actions that need your attention.',
    group: AppDestinationGroup.review,
  ),
  AppDestination(
    label: 'Payments',
    path: '/payments',
    icon: Icons.credit_card_outlined,
    selectedIcon: Icons.credit_card_rounded,
    eyebrow: 'TRUSTED SURFACE',
    description: 'Review exact purchase mandates and payment evidence.',
    group: AppDestinationGroup.review,
  ),
  AppDestination(
    label: 'Results',
    path: '/results',
    icon: Icons.fact_check_outlined,
    selectedIcon: Icons.fact_check_rounded,
    eyebrow: 'EVIDENCE LEDGER',
    description: 'Review completed work with evidence and verification.',
    group: AppDestinationGroup.review,
  ),
  AppDestination(
    label: 'Quality Checks',
    path: '/quality',
    icon: Icons.rule_outlined,
    selectedIcon: Icons.rule_rounded,
    eyebrow: 'EVALUATIONS',
    description: 'Automated checks that verify agent behavior.',
    group: AppDestinationGroup.review,
  ),
  AppDestination(
    label: 'Monitoring',
    path: '/monitoring',
    icon: Icons.monitor_heart_outlined,
    selectedIcon: Icons.monitor_heart_rounded,
    eyebrow: 'SYSTEM HEALTH',
    description: 'Events, service health, alerts, and incidents.',
    group: AppDestinationGroup.system,
  ),
  AppDestination(
    label: 'Security',
    path: '/security',
    icon: Icons.shield_outlined,
    selectedIcon: Icons.shield_rounded,
    eyebrow: 'ACCESS + PRIVACY',
    description: 'Access control, audits, retention, and isolation.',
    group: AppDestinationGroup.system,
  ),
  AppDestination(
    label: 'Settings',
    path: '/settings',
    icon: Icons.tune_outlined,
    selectedIcon: Icons.tune_rounded,
    eyebrow: 'CONFIGURATION',
    description: 'Models, environment, identity, and portable data.',
    group: AppDestinationGroup.system,
  ),
];

int destinationIndex(String path) =>
    appDestinations.indexWhere((destination) => destination.path == path);

List<int> destinationIndices({AppDestinationGroup? group, bool? primary}) => [
  for (var index = 0; index < appDestinations.length; index++)
    if ((group == null || appDestinations[index].group == group) &&
        (primary == null || appDestinations[index].primary == primary))
      index,
];
