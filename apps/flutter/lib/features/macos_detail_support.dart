import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../app/theme/macos_app_theme.dart';

enum MacosDetailTone { neutral, accent, positive, warning, danger }

/// A desktop back affordance that remains useful when a detail deep link is
/// opened directly instead of being pushed from its collection route.
class MacosDetailBackButton extends StatelessWidget {
  const MacosDetailBackButton({
    super.key,
    required this.fallbackLocation,
    required this.label,
  });

  final String fallbackLocation;
  final String label;

  @override
  Widget build(BuildContext context) => TextButton.icon(
    key: const Key('macos-detail-back'),
    onPressed: () => macosNavigateBack(context, fallbackLocation),
    icon: const Icon(Icons.arrow_back_rounded, size: 17),
    label: Text(label),
  );
}

void macosNavigateBack(BuildContext context, String fallbackLocation) {
  final router = GoRouter.maybeOf(context);
  if (router?.canPop() ?? false) {
    router!.pop();
  } else if (router != null) {
    router.go(fallbackLocation);
  } else {
    Navigator.maybeOf(context)?.maybePop();
  }
}

class MacosStatusBadge extends StatelessWidget {
  const MacosStatusBadge({
    super.key,
    required this.label,
    this.tone = MacosDetailTone.neutral,
    this.icon,
  });

  final String label;
  final MacosDetailTone tone;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final mac = MacosThemeColors.of(context);
    final (foreground, background) = switch (tone) {
      MacosDetailTone.neutral => (scheme.onSurfaceVariant, mac.hover),
      MacosDetailTone.accent => (scheme.primary, mac.selection),
      MacosDetailTone.positive => (
        mac.positive,
        mac.positive.withValues(alpha: .11),
      ),
      MacosDetailTone.warning => (
        mac.warning,
        mac.warning.withValues(alpha: .12),
      ),
      MacosDetailTone.danger => (
        scheme.error,
        scheme.error.withValues(alpha: .1),
      ),
    };
    return DecoratedBox(
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: foreground.withValues(alpha: .22)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null) ...[
              Icon(icon, size: 13, color: foreground),
              const SizedBox(width: 5),
            ],
            Text(
              label,
              style: Theme.of(context).textTheme.labelSmall
                  ?.copyWith(color: foreground, fontWeight: FontWeight.w700),
            ),
          ],
        ),
      ),
    );
  }
}

class MacosInspectorSection extends StatelessWidget {
  const MacosInspectorSection({
    super.key,
    required this.title,
    required this.child,
    this.description,
  });

  final String title;
  final String? description;
  final Widget child;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(18, 18, 18, 0),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title.toUpperCase(),
          style: Theme.of(context).textTheme.labelSmall?.copyWith(
            letterSpacing: .8,
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        ),
        if (description != null) ...[
          const SizedBox(height: 4),
          Text(description!, style: Theme.of(context).textTheme.bodySmall),
        ],
        const SizedBox(height: 10),
        child,
      ],
    ),
  );
}

class MacosKeyValue extends StatelessWidget {
  const MacosKeyValue({
    super.key,
    required this.label,
    required this.value,
    this.valueColor,
  });

  final String label;
  final String value;
  final Color? valueColor;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 5),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 104,
          child: Text(label, style: Theme.of(context).textTheme.bodySmall),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: SelectableText(
            value,
            style: Theme.of(context).textTheme.bodyMedium
                ?.copyWith(color: valueColor, fontWeight: FontWeight.w500),
          ),
        ),
      ],
    ),
  );
}

class MacosDetailNotice extends StatelessWidget {
  const MacosDetailNotice({
    super.key,
    required this.message,
    this.action,
    this.tone = MacosDetailTone.warning,
  });

  final String message;
  final Widget? action;
  final MacosDetailTone tone;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final mac = MacosThemeColors.of(context);
    final (foreground, background, icon) = switch (tone) {
      MacosDetailTone.danger => (
        scheme.error,
        scheme.errorContainer.withValues(alpha: .7),
        Icons.error_outline_rounded,
      ),
      MacosDetailTone.positive => (
        mac.positive,
        mac.positive.withValues(alpha: .09),
        Icons.check_circle_outline_rounded,
      ),
      _ => (
        mac.warning,
        mac.warning.withValues(alpha: .09),
        Icons.info_outline_rounded,
      ),
    };
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
      decoration: BoxDecoration(
        color: background,
        border: Border(
          bottom: BorderSide(color: foreground.withValues(alpha: .2)),
        ),
      ),
      child: Row(
        children: [
          Icon(icon, color: foreground, size: 17),
          const SizedBox(width: 9),
          Expanded(
            child: Text(message, maxLines: 2, overflow: TextOverflow.ellipsis),
          ),
          if (action != null) ...[const SizedBox(width: 10), action!],
        ],
      ),
    );
  }
}

MacosDetailTone macosToneForStatus(String value) {
  final status = value.toLowerCase();
  if (const {
    'completed',
    'done',
    'verified',
    'healthy',
    'active',
    'accepted',
    'fresh',
  }.contains(status)) {
    return MacosDetailTone.positive;
  }
  if (const {
    'running',
    'doing',
    'scheduled',
    'in_progress',
    'waiting_approval',
    'pending',
    'paused',
  }.contains(status)) {
    return MacosDetailTone.warning;
  }
  if (const {
    'failed',
    'blocked',
    'cancelled',
    'canceled',
    'rejected',
    'at_risk',
    'stale',
  }.contains(status)) {
    return MacosDetailTone.danger;
  }
  return MacosDetailTone.neutral;
}

String macosHumanize(String value) => value
    .split(RegExp(r'[._:-]'))
    .where((part) => part.isNotEmpty)
    .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
    .join(' ');
