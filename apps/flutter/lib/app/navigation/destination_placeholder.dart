import 'package:flutter/material.dart';

import 'app_destination.dart';

class DestinationPlaceholder extends StatelessWidget {
  const DestinationPlaceholder({super.key, required this.destination});
  final AppDestination destination;

  @override
  Widget build(BuildContext context) => SafeArea(
    child: CustomScrollView(
      slivers: [
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(24, 28, 24, 12),
          sliver: SliverToBoxAdapter(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 1120),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    destination.eyebrow,
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      color: Theme.of(context).colorScheme.primary,
                      letterSpacing: 1.8,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    destination.label,
                    style: Theme.of(context).textTheme.displaySmall,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    destination.description,
                    style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 30),
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(28),
                      child: Row(
                        children: [
                          Icon(
                            destination.selectedIcon,
                            size: 32,
                            color: Theme.of(context).colorScheme.primary,
                          ),
                          const SizedBox(width: 18),
                          const Expanded(
                            child: Text(
                              'Workspace module connected and ready for live data.',
                            ),
                          ),
                          Container(
                            width: 9,
                            height: 9,
                            decoration: const BoxDecoration(
                              color: Color(0xFF19C37D),
                              shape: BoxShape.circle,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    ),
  );
}
