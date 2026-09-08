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
    eyebrow: 'YOUR DAYBOOK',
    description: 'Your work, decisions, and recent results.',
  ),
  AppDestination(
    label: 'Command',
    path: '/talk',
    icon: Icons.graphic_eq_rounded,
    selectedIcon: Icons.multitrack_audio_rounded,
    eyebrow: 'ASK OR DELEGATE',
    description: 'Ask Asael a question or hand off a task.',
  ),
  AppDestination(
    label: 'Capture',
    path: '/capture',
    icon: Icons.add_circle_outline_rounded,
    selectedIcon: Icons.add_circle_rounded,
    eyebrow: 'SECOND BRAIN',
    description: 'Save a note or file to your second brain.',
  ),
  AppDestination(
    label: 'Missions',
    path: '/missions',
    icon: Icons.route_outlined,
    selectedIcon: Icons.route_rounded,
    eyebrow: 'DURABLE WORK',
    description: 'Durable outcomes, delegated work, and evidence.',
  ),
  AppDestination(
    label: 'Projects',
    path: '/projects',
    icon: Icons.folder_copy_outlined,
    selectedIcon: Icons.folder_copy_rounded,
    eyebrow: 'PLANNED OUTCOMES',
    description: 'Plan, execute, and verify project work.',
  ),
  AppDestination(
    label: 'Meetings',
    path: '/meetings',
    icon: Icons.groups_2_outlined,
    selectedIcon: Icons.groups_2_rounded,
    eyebrow: 'DECISION MEMORY',
    description: 'Calendar context, consent, decisions, and follow-through.',
  ),
  AppDestination(
    label: 'Results',
    path: '/results',
    icon: Icons.fact_check_outlined,
    selectedIcon: Icons.fact_check_rounded,
    eyebrow: 'EVIDENCE LEDGER',
    description: 'Review completed work with evidence and verification.',
  ),
  AppDestination(
    label: 'Inbox',
    path: '/inbox',
    icon: Icons.inbox_outlined,
    selectedIcon: Icons.inbox_rounded,
    eyebrow: 'ATTENTION QUEUE',
    description: 'Review actions that need your attention.',
  ),
  AppDestination(
    label: 'Arsenal',
    path: '/agents',
    icon: Icons.hub_outlined,
    selectedIcon: Icons.hub_rounded,
    eyebrow: 'AGENT ARSENAL',
    description: 'Your specialists, capabilities, and adaptation lifecycle.',
  ),
  AppDestination(
    label: 'Memory',
    path: '/knowledge',
    icon: Icons.account_tree_outlined,
    selectedIcon: Icons.account_tree_rounded,
    eyebrow: 'DURABLE CONTEXT',
    description: 'What your second brain knows and remembers.',
  ),
];
