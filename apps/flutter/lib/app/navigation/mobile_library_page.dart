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
          title: 'Needs your attention',
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
        (
          title: 'Payments',
          subtitle: 'Review payment requests and receipts',
          path: '/payments',
          icon: Icons.credit_card_outlined,
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
            subtitle: 'Your knowledge, tools and preferences.',
            actions: [
              IconButton(
                tooltip: 'Search your content',
                onPressed: () => context.push('/search'),
                icon: const Icon(Icons.search_rounded),
              ),
            ],
          ),
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
            SliverList.builder(
              itemCount: group.items.length,
              itemBuilder: (context, index) {
                final item = group.items[index];
                return MobileActionTile(
                  icon: item.icon,
                  title: item.title,
                  subtitle: item.subtitle,
                  onTap: () => context.push(item.path),
                );
              },
            ),
          ],
        const SliverToBoxAdapter(child: SizedBox(height: 24)),
      ],
    );
  }
}
