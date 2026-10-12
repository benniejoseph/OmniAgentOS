import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../mobile/mobile_page_scaffold.dart';

/// A navigation index, not a dashboard: opening Library performs no feature
/// reads, starts no controllers and never reports invented activity counts.
class MobileLibraryPage extends StatefulWidget {
  const MobileLibraryPage({super.key});

  @override
  State<MobileLibraryPage> createState() => _MobileLibraryPageState();
}

class _MobileLibraryPageState extends State<MobileLibraryPage> {
  String _query = '';

  static const _groups = [
    (
      title: 'Remember & discover',
      items: [
        (
          title: 'Capture',
          subtitle: 'Save a note, scan or file',
          path: '/capture',
          icon: Icons.add_circle_outline_rounded,
        ),
        (
          title: 'Listen & conversations',
          subtitle: 'Record and revisit conversation notes',
          path: '/capture?section=listen',
          icon: Icons.hearing_rounded,
        ),
        (
          title: 'Memory',
          subtitle: 'Your context, knowledge and connections',
          path: '/knowledge',
          icon: Icons.account_tree_outlined,
        ),
        (
          title: 'Saved files',
          subtitle: 'Notes, documents and captured files',
          path: '/capture?tab=library',
          icon: Icons.folder_open_rounded,
        ),
        (
          title: 'History',
          subtitle: 'Results and a timeline of your work',
          path: '/activity',
          icon: Icons.history_rounded,
        ),
        (
          title: 'Markets',
          subtitle: 'Gold research, evidence and market context',
          path: '/markets',
          icon: Icons.candlestick_chart_outlined,
        ),
      ],
    ),
    (
      title: 'Plan & follow through',
      items: [
        (
          title: 'Needs you',
          subtitle: 'Decisions and approvals to review',
          path: '/inbox',
          icon: Icons.inbox_outlined,
        ),
        (
          title: 'Meetings',
          subtitle: 'Your agenda, notes and follow-ups',
          path: '/meetings',
          icon: Icons.event_note_rounded,
        ),
        (
          title: 'Follow-ups',
          subtitle: 'Ongoing checks and commitments',
          path: '/responsibilities',
          icon: Icons.event_repeat_rounded,
        ),
      ],
    ),
    (
      title: 'Your assistant',
      items: [
        (
          title: 'Agents',
          subtitle: 'Your specialists and their work',
          path: '/agents',
          icon: Icons.hub_outlined,
        ),
        (
          title: 'Capabilities',
          subtitle: 'Connections, skills and automations',
          path: '/automation',
          icon: Icons.auto_awesome_motion_outlined,
        ),
      ],
    ),
    (
      title: 'Make it yours',
      items: [
        (
          title: 'Settings',
          subtitle: 'You, ATLAS, your phone and preferences',
          path: '/settings',
          icon: Icons.tune_rounded,
        ),
        (
          title: 'Nightly call notes',
          subtitle: 'Call folder, schedule and processing',
          path: '/settings?section=listening',
          icon: Icons.nights_stay_outlined,
        ),
        (
          title: 'Security & privacy',
          subtitle: 'Your access, devices and data',
          path: '/security',
          icon: Icons.shield_outlined,
        ),
      ],
    ),
  ];

  @override
  Widget build(BuildContext context) {
    final query = _query.trim().toLowerCase();
    final groups = [
      for (final group in _groups)
        (
          title: group.title,
          items: group.items
              .where(
                (item) =>
                    query.isEmpty ||
                    '${item.title} ${item.subtitle}'.toLowerCase().contains(
                      query,
                    ),
              )
              .toList(),
        ),
    ];
    final hasResults = groups.any((group) => group.items.isNotEmpty);
    return CustomScrollView(
      key: const PageStorageKey('mobile-library'),
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      slivers: [
        SliverToBoxAdapter(
          child: MobilePageHeader(
            title: 'Library',
            actions: [
              IconButton(
                tooltip: 'Needs you',
                onPressed: () => context.push('/inbox'),
                icon: const Icon(Icons.inbox_outlined),
              ),
              IconButton(
                tooltip: 'Settings',
                onPressed: () => context.push('/settings'),
                icon: const Icon(Icons.tune_rounded),
              ),
            ],
          ),
        ),
        if (query.isEmpty)
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(20, 4, 20, 4),
            sliver: SliverToBoxAdapter(child: _collections(context)),
          ),
        SliverPadding(
          padding: const EdgeInsets.symmetric(horizontal: 20),
          sliver: SliverToBoxAdapter(
            child: TextField(
              onChanged: (value) => setState(() => _query = value),
              textInputAction: TextInputAction.search,
              decoration: const InputDecoration(
                hintText: 'Find a feature or setting',
                prefixIcon: Icon(Icons.search_rounded),
              ),
            ),
          ),
        ),
        if (!hasResults)
          const SliverPadding(
            padding: EdgeInsets.all(24),
            sliver: SliverToBoxAdapter(
              child: Text(
                'No matching spaces. Try “memory”, “calls” or “settings”.',
              ),
            ),
          ),
        for (final group in groups)
          if (group.items.isNotEmpty) ...[
            SliverToBoxAdapter(child: MobileSectionHeader(title: group.title)),
            SliverPadding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              sliver: SliverToBoxAdapter(
                child: MobileSurface(
                  padding: EdgeInsets.zero,
                  child: Column(
                    children: [
                      for (final item in group.items)
                        if (query.isNotEmpty ||
                            !const [
                              '/knowledge',
                              '/capture?tab=library',
                              '/activity',
                            ].contains(item.path))
                          MobileActionTile(
                            icon: item.icon,
                            title: item.title,
                            subtitle: item.subtitle,
                            onTap: () => context.push(item.path),
                          ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        const SliverToBoxAdapter(child: SizedBox(height: 24)),
      ],
    );
  }

  Widget _collections(BuildContext context) {
    final compact =
        MediaQuery.sizeOf(context).width < 360 ||
        MediaQuery.textScalerOf(context).scale(16) > 21;
    final memory = _collection(
      context,
      title: 'Memory',
      subtitle: 'The things worth remembering',
      icon: Icons.psychology_outlined,
      path: '/knowledge',
      spotlight: true,
      large: true,
    );
    final files = _collection(
      context,
      title: 'Saved files',
      subtitle: 'Notes, scans & documents',
      icon: Icons.folder_open_rounded,
      path: '/capture?tab=library',
    );
    final history = _collection(
      context,
      title: 'History',
      subtitle: 'Results & recent activity',
      icon: Icons.history_rounded,
      path: '/activity',
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (compact) ...[
          memory,
          const SizedBox(height: 12),
          files,
          const SizedBox(height: 12),
          history,
        ] else
          IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(child: memory),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    children: [files, const SizedBox(height: 12), history],
                  ),
                ),
              ],
            ),
          ),
        const SizedBox(height: 12),
        TextButton.icon(
          onPressed: () => context.push('/search'),
          icon: const Icon(Icons.search_rounded, size: 18),
          label: const Text('Search your saved content'),
        ),
      ],
    );
  }

  Widget _collection(
    BuildContext context, {
    required String title,
    required String subtitle,
    required IconData icon,
    required String path,
    bool spotlight = false,
    bool large = false,
  }) => MobileSurface(
    spotlight: spotlight,
    padding: EdgeInsets.zero,
    child: Builder(
      builder: (tileContext) {
        final theme = Theme.of(tileContext);
        return InkWell(
          onTap: () => context.push(path),
          child: Padding(
            padding: EdgeInsets.all(large ? 20 : 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Row(
                  children: [
                    Icon(
                      icon,
                      color: theme.colorScheme.secondary,
                      size: large ? 30 : 22,
                    ),
                    const Spacer(),
                    Icon(
                      Icons.north_east_rounded,
                      size: 16,
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ],
                ),
                Padding(
                  padding: EdgeInsets.only(top: large ? 42 : 14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        title,
                        style: large
                            ? theme.textTheme.headlineSmall
                            : theme.textTheme.titleMedium,
                      ),
                      const SizedBox(height: 5),
                      Text(subtitle, style: theme.textTheme.bodySmall),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      },
    ),
  );
}
