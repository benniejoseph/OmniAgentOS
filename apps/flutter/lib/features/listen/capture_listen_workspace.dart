import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/network/native_workspace_access.dart';
import 'listen_view.dart';

class CaptureListenWorkspace extends StatelessWidget {
  const CaptureListenWorkspace({
    super.key,
    required this.capture,
    this.listening = false,
  });
  final Widget capture;
  final bool listening;
  @override
  Widget build(BuildContext context) => Column(
    children: [
      Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          border: Border(
            bottom: BorderSide(
              color: Theme.of(context).colorScheme.outlineVariant,
            ),
          ),
        ),
        child: Wrap(
          spacing: 8,
          runSpacing: 4,
          children: [
            for (final item in const [
              (
                listen: false,
                label: 'Add something',
                icon: Icons.add_circle_outline_rounded,
              ),
              (
                listen: true,
                label: 'Listen & conversations',
                icon: Icons.hearing_rounded,
              ),
            ])
              Semantics(
                selected: listening == item.listen,
                child: TextButton.icon(
                  onPressed: () => context.go(
                    item.listen ? '/capture?section=listen' : '/capture',
                  ),
                  style: TextButton.styleFrom(
                    backgroundColor: listening == item.listen
                        ? Theme.of(context).colorScheme.secondaryContainer
                        : null,
                  ),
                  icon: Icon(item.icon, size: 18),
                  label: Text(item.label),
                ),
              ),
          ],
        ),
      ),
      Expanded(
        child: listening
            ? NativePrivateWorkspace(builder: (_) => const ListenWorkspace())
            : capture,
      ),
    ],
  );
}
