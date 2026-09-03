import 'package:flutter/material.dart';

class AppDestination {
  const AppDestination({
    required this.label,
    required this.path,
    required this.icon,
    required this.selectedIcon,
    required this.eyebrow,
    required this.description,
  });

  final String label;
  final String path;
  final IconData icon;
  final IconData selectedIcon;
  final String eyebrow;
  final String description;
}

const appDestinations = <AppDestination>[
  AppDestination(
    label: 'Today',
    path: '/today',
    icon: Icons.grid_view_outlined,
    selectedIcon: Icons.grid_view_rounded,
    eyebrow: 'COMMAND SURFACE',
    description: 'Live priorities, briefings, and system pulse.',
  ),
  AppDestination(
    label: 'Talk',
    path: '/talk',
    icon: Icons.graphic_eq_rounded,
    selectedIcon: Icons.multitrack_audio_rounded,
    eyebrow: 'AGENT CHANNEL',
    description: 'A direct line to your agent network.',
  ),
  AppDestination(
    label: 'Capture',
    path: '/capture',
    icon: Icons.add_circle_outline_rounded,
    selectedIcon: Icons.add_circle_rounded,
    eyebrow: 'QUICK CAPTURE',
    description: 'Turn raw input into structured action.',
  ),
  AppDestination(
    label: 'Missions',
    path: '/missions',
    icon: Icons.route_outlined,
    selectedIcon: Icons.route_rounded,
    eyebrow: 'EXECUTION MAP',
    description: 'Plan, delegate, and observe every mission.',
  ),
  AppDestination(
    label: 'Projects',
    path: '/projects',
    icon: Icons.folder_copy_outlined,
    selectedIcon: Icons.folder_copy_rounded,
    eyebrow: 'DURABLE OUTCOMES',
    description: 'Plan, execute, and verify long-running outcomes.',
  ),
  AppDestination(
    label: 'Results',
    path: '/results',
    icon: Icons.fact_check_outlined,
    selectedIcon: Icons.fact_check_rounded,
    eyebrow: 'EVIDENCE LEDGER',
    description: 'Outputs, approvals, evaluations, and verification.',
  ),
  AppDestination(
    label: 'Inbox',
    path: '/inbox',
    icon: Icons.inbox_outlined,
    selectedIcon: Icons.inbox_rounded,
    eyebrow: 'ATTENTION QUEUE',
    description: 'Review decisions, alerts, and agent handoffs.',
  ),
  AppDestination(
    label: 'Agents',
    path: '/agents',
    icon: Icons.hub_outlined,
    selectedIcon: Icons.hub_rounded,
    eyebrow: 'AGENT ARSENAL',
    description: 'Build agents, assign skills, and inspect performance.',
  ),
  AppDestination(
    label: 'Knowledge',
    path: '/knowledge',
    icon: Icons.account_tree_outlined,
    selectedIcon: Icons.account_tree_rounded,
    eyebrow: 'DURABLE CONTEXT',
    description: 'Search, correct, and connect long-term memory.',
  ),
];
