import 'dart:async';

import 'package:flutter/material.dart';

import 'talk_history.dart';

const double talkHistoryDesktopBreakpoint = 1280;

class TalkHistoryPane extends StatelessWidget {
  const TalkHistoryPane({
    super.key,
    required this.controller,
    required this.onSelected,
    required this.onNew,
  });

  final TalkHistoryControllerMixin controller;
  final ValueChanged<String> onSelected;
  final VoidCallback onNew;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final loading = controller.historyState == TalkHistoryState.loading;
    final refreshing = controller.historyState == TalkHistoryState.refreshing;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: scheme.surface.withValues(alpha: .9),
        border: Border(right: BorderSide(color: scheme.outlineVariant)),
      ),
      child: SafeArea(
        right: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 16, 10, 12),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Conversations',
                          style: Theme.of(context).textTheme.titleMedium
                              ?.copyWith(fontWeight: FontWeight.w700),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          'Durable, private history',
                          style: TextStyle(
                            color: scheme.onSurfaceVariant,
                            fontSize: 11.5,
                          ),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: 'Refresh conversations',
                    onPressed: loading || refreshing
                        ? null
                        : () => unawaited(
                            controller.loadRecentThreads(force: true),
                          ),
                    icon: refreshing
                        ? const SizedBox.square(
                            dimension: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.refresh_rounded, size: 20),
                  ),
                  IconButton.filledTonal(
                    tooltip: 'New conversation',
                    onPressed: controller.historyInteractionBusy ? null : onNew,
                    icon: const Icon(Icons.add_rounded, size: 20),
                  ),
                ],
              ),
            ),
            if (loading || refreshing)
              const LinearProgressIndicator(minHeight: 2),
            Divider(height: 1, color: scheme.outlineVariant),
            if (controller.historyState == TalkHistoryState.stale)
              _HistoryNotice(
                icon: Icons.cloud_off_outlined,
                text: 'Showing the last loaded list. Refresh is unavailable.',
                color: scheme.secondary,
              ),
            Expanded(child: _buildHistoryBody(context)),
            if (controller.hasSelectedThread)
              _MemoryContextSummary(controller: controller),
          ],
        ),
      ),
    );
  }

  Widget _buildHistoryBody(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    if (controller.historyState == TalkHistoryState.loading &&
        controller.recentThreads.isEmpty) {
      return const _HistoryCenteredState(
        icon: Icons.history_rounded,
        title: 'Loading conversations',
        body: 'Reading your private conversation index.',
        progress: true,
      );
    }
    if (controller.historyState == TalkHistoryState.error &&
        controller.recentThreads.isEmpty) {
      return _HistoryCenteredState(
        icon: Icons.cloud_off_outlined,
        title: 'History is unavailable',
        body: 'Your current draft is safe. Try the read again.',
        action: TextButton.icon(
          onPressed: () => unawaited(controller.loadRecentThreads(force: true)),
          icon: const Icon(Icons.refresh_rounded),
          label: const Text('Try again'),
        ),
      );
    }
    if (controller.recentThreads.isEmpty) {
      return const _HistoryCenteredState(
        icon: Icons.chat_bubble_outline_rounded,
        title: 'No conversations yet',
        body: 'Your first message will start a durable conversation.',
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(10, 10, 10, 18),
      itemCount: controller.recentThreads.length,
      separatorBuilder: (_, _) => const SizedBox(height: 3),
      itemBuilder: (context, index) {
        final thread = controller.recentThreads[index];
        final selected = controller.threadId == thread.id;
        final opening = controller.openingThreadId == thread.id;
        return Material(
          key: ValueKey('conversation-${thread.id}'),
          color: selected
              ? scheme.primaryContainer.withValues(alpha: .68)
              : Colors.transparent,
          borderRadius: BorderRadius.circular(13),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: controller.historyInteractionBusy || opening
                ? null
                : () => onSelected(thread.id),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 11, 10, 10),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          thread.title,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 13,
                            height: 1.25,
                            fontWeight: selected
                                ? FontWeight.w700
                                : FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 6),
                        Text(
                          '${_modeLabel(thread.mode)} · ${_historyAge(thread.updatedAt)}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: scheme.onSurfaceVariant,
                            fontSize: 10.5,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 6),
                  if (opening)
                    const Padding(
                      padding: EdgeInsets.only(top: 2),
                      child: SizedBox.square(
                        dimension: 15,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    )
                  else if (selected)
                    Icon(
                      Icons.radio_button_checked_rounded,
                      size: 15,
                      color: scheme.primary,
                    ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

class _HistoryNotice extends StatelessWidget {
  const _HistoryNotice({
    required this.icon,
    required this.text,
    required this.color,
  });

  final IconData icon;
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.fromLTRB(14, 9, 14, 9),
    color: color.withValues(alpha: .1),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 15, color: color),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            text,
            style: TextStyle(color: color, fontSize: 11.5, height: 1.3),
          ),
        ),
      ],
    ),
  );
}

class _HistoryCenteredState extends StatelessWidget {
  const _HistoryCenteredState({
    required this.icon,
    required this.title,
    required this.body,
    this.progress = false,
    this.action,
  });

  final IconData icon;
  final String title;
  final String body;
  final bool progress;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (progress)
              const SizedBox.square(
                dimension: 22,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            else
              Icon(icon, size: 26, color: scheme.onSurfaceVariant),
            const SizedBox(height: 11),
            Text(
              title,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleSmall,
            ),
            const SizedBox(height: 5),
            Text(
              body,
              textAlign: TextAlign.center,
              style: TextStyle(
                color: scheme.onSurfaceVariant,
                fontSize: 11.5,
                height: 1.35,
              ),
            ),
            if (action != null) ...[const SizedBox(height: 9), action!],
          ],
        ),
      ),
    );
  }
}

class _MemoryContextSummary extends StatelessWidget {
  const _MemoryContextSummary({required this.controller});

  final TalkHistoryControllerMixin controller;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final state = controller.memoryContextState;
    final title = switch (state) {
      TalkMemoryContextState.loading => 'Reading linked memory\u2026',
      TalkMemoryContextState.ready =>
        '${controller.selectedThreadMemoryCount} linked ${controller.selectedThreadMemoryCount == 1 ? 'memory' : 'memories'}',
      TalkMemoryContextState.empty => 'No linked memory yet',
      TalkMemoryContextState.stale => 'Memory context unavailable',
      TalkMemoryContextState.idle => 'Memory context',
    };
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 11, 16, 13),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow.withValues(alpha: .76),
        border: Border(top: BorderSide(color: scheme.outlineVariant)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 1),
            child: state == TalkMemoryContextState.loading
                ? const SizedBox.square(
                    dimension: 14,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Icon(
                    state == TalkMemoryContextState.stale
                        ? Icons.cloud_off_outlined
                        : Icons.psychology_alt_outlined,
                    size: 16,
                    color: state == TalkMemoryContextState.stale
                        ? scheme.secondary
                        : scheme.primary,
                  ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                if (state == TalkMemoryContextState.ready &&
                    controller.selectedThreadMemories.isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(
                    controller.selectedThreadMemories
                        .take(2)
                        .map((memory) => memory.title)
                        .join(' · '),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: scheme.onSurfaceVariant,
                      fontSize: 10.5,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class TalkThreadProjectionBanner extends StatelessWidget {
  const TalkThreadProjectionBanner({super.key, required this.controller});

  final TalkHistoryControllerMixin controller;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final (icon, text, action, color) = switch (controller.threadState) {
      TalkThreadState.loading => (
        Icons.sync_rounded,
        'Opening the exact conversation\u2026',
        null,
        scheme.primary,
      ),
      TalkThreadState.error => (
        Icons.error_outline_rounded,
        'This conversation could not be opened. Your current draft is unchanged.',
        'Try again',
        scheme.error,
      ),
      TalkThreadState.stale => (
        Icons.cloud_off_outlined,
        'Showing the last loaded conversation. Refresh is unavailable.',
        'Refresh',
        scheme.secondary,
      ),
      _ when controller.memoryContextState == TalkMemoryContextState.stale => (
        Icons.psychology_alt_outlined,
        'The transcript is current, but linked memory could not refresh.',
        'Refresh',
        scheme.secondary,
      ),
      _ => (null, null, null, scheme.primary),
    };
    if (text == null || icon == null) return const SizedBox.shrink();
    return Container(
      width: double.infinity,
      color: color.withValues(alpha: .09),
      padding: const EdgeInsets.fromLTRB(16, 8, 12, 8),
      child: Row(
        children: [
          if (controller.threadState == TalkThreadState.loading)
            SizedBox.square(
              dimension: 15,
              child: CircularProgressIndicator(strokeWidth: 2, color: color),
            )
          else
            Icon(icon, size: 17, color: color),
          const SizedBox(width: 9),
          Expanded(
            child: Text(text, style: TextStyle(color: color, fontSize: 12)),
          ),
          if (action != null)
            TextButton(
              onPressed: controller.historyInteractionBusy
                  ? null
                  : controller.retryOpenThread,
              child: Text(action),
            ),
        ],
      ),
    );
  }
}

String _modeLabel(String mode) => switch (mode) {
  'research' => 'Research',
  'execute' => 'Execute',
  'learn' => 'Learn',
  _ => 'Orchestrate',
};

String _historyAge(DateTime? updatedAt) {
  if (updatedAt == null) return 'Recently updated';
  final difference = DateTime.now().difference(updatedAt);
  if (difference.isNegative || difference.inMinutes < 1) return 'Just now';
  if (difference.inMinutes < 60) return '${difference.inMinutes}m ago';
  if (difference.inHours < 24) return '${difference.inHours}h ago';
  if (difference.inDays < 7) return '${difference.inDays}d ago';
  return '${updatedAt.month}/${updatedAt.day}/${updatedAt.year}';
}
