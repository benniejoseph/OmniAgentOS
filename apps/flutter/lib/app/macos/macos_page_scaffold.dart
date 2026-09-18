import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/macos_app_theme.dart';

/// Shared desktop page frame. Feature presenters keep their existing
/// controllers and repositories, while this widget supplies consistent Mac
/// hierarchy, pointer density, actions, and optional inspector behavior.
class MacosPageScaffold extends StatelessWidget {
  const MacosPageScaffold({
    super.key,
    required this.title,
    required this.description,
    required this.icon,
    required this.body,
    this.actions = const [],
    this.primaryAction,
    this.toolbar,
    this.inspector,
    this.inspectorWidth = 330,
    this.inspectorMinWidth = 270,
    this.inspectorMaxWidth = 460,
    this.inspectorCollapseBelow = 880,
    this.maxContentWidth,
  });

  final String title;
  final String description;
  final IconData icon;
  final Widget body;
  final List<Widget> actions;
  final Widget? primaryAction;
  final Widget? toolbar;
  final Widget? inspector;
  final double inspectorWidth;
  final double inspectorMinWidth;
  final double inspectorMaxWidth;
  final double inspectorCollapseBelow;
  final double? maxContentWidth;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Scaffold(
      body: Column(
        children: [
          _MacosPageHeader(
            title: title,
            description: description,
            icon: icon,
            actions: actions,
            primaryAction: primaryAction,
          ),
          if (toolbar != null) ...[
            DecoratedBox(
              decoration: BoxDecoration(
                color: mac.toolbar,
                border: Border(bottom: BorderSide(color: mac.divider)),
              ),
              child: SizedBox(
                width: double.infinity,
                height: 48,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 18),
                  child: Align(alignment: Alignment.centerLeft, child: toolbar),
                ),
              ),
            ),
          ],
          Expanded(
            child: inspector == null
                ? _ConstrainedDesktopBody(
                    maxWidth: maxContentWidth,
                    child: body,
                  )
                : MacosResizableInspector(
                    initialWidth: inspectorWidth,
                    minWidth: inspectorMinWidth,
                    maxWidth: inspectorMaxWidth,
                    collapseBelow: inspectorCollapseBelow,
                    body: _ConstrainedDesktopBody(
                      maxWidth: maxContentWidth,
                      child: body,
                    ),
                    inspector: inspector!,
                  ),
          ),
        ],
      ),
    );
  }
}

class _MacosPageHeader extends StatelessWidget {
  const _MacosPageHeader({
    required this.title,
    required this.description,
    required this.icon,
    required this.actions,
    required this.primaryAction,
  });

  final String title;
  final String description;
  final IconData icon;
  final List<Widget> actions;
  final Widget? primaryAction;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final mac = MacosThemeColors.of(context);
    return Container(
      width: double.infinity,
      constraints: const BoxConstraints(minHeight: 76),
      padding: const EdgeInsets.fromLTRB(22, 14, 18, 13),
      decoration: BoxDecoration(
        color: scheme.surface.withValues(alpha: .94),
        border: Border(bottom: BorderSide(color: mac.divider)),
      ),
      child: Row(
        children: [
          Container(
            width: 38,
            height: 38,
            decoration: BoxDecoration(
              color: mac.selection,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(icon, size: 19, color: scheme.primary),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text(title, style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 3),
                Text(
                  description,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall
                      ?.copyWith(color: scheme.onSurfaceVariant),
                ),
              ],
            ),
          ),
          if (actions.isNotEmpty) ...[
            const SizedBox(width: 16),
            for (final action in actions) ...[action, const SizedBox(width: 4)],
          ],
          if (primaryAction != null) ...[
            const SizedBox(width: 10),
            primaryAction!,
          ],
        ],
      ),
    );
  }
}

class _ConstrainedDesktopBody extends StatelessWidget {
  const _ConstrainedDesktopBody({required this.maxWidth, required this.child});

  final double? maxWidth;
  final Widget child;

  @override
  Widget build(BuildContext context) => maxWidth == null
      ? child
      : Align(
          alignment: Alignment.topCenter,
          child: ConstrainedBox(
            constraints: BoxConstraints(maxWidth: maxWidth!),
            child: child,
          ),
        );
}

class MacosResizableInspector extends StatefulWidget {
  const MacosResizableInspector({
    super.key,
    required this.body,
    required this.inspector,
    this.initialWidth = 330,
    this.minWidth = 270,
    this.maxWidth = 460,
    this.collapseBelow = 880,
  });

  final Widget body;
  final Widget inspector;
  final double initialWidth;
  final double minWidth;
  final double maxWidth;
  final double collapseBelow;

  @override
  State<MacosResizableInspector> createState() =>
      _MacosResizableInspectorState();
}

class _MacosResizableInspectorState extends State<MacosResizableInspector> {
  static const _keyboardStep = 24.0;

  final FocusNode _dividerFocusNode = FocusNode(
    debugLabel: 'macOS inspector resize divider',
  );
  bool _dividerFocused = false;
  late double _width = widget.initialWidth.clamp(
    widget.minWidth,
    widget.maxWidth,
  );

  @override
  void dispose() {
    _dividerFocusNode.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant MacosResizableInspector oldWidget) {
    super.didUpdateWidget(oldWidget);
    _width = _width.clamp(widget.minWidth, widget.maxWidth);
  }

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth < widget.collapseBelow) {
          return bodyWithInspectorSheet(context);
        }
        return Row(
          children: [
            Expanded(child: widget.body),
            Focus(
              focusNode: _dividerFocusNode,
              onFocusChange: (focused) =>
                  setState(() => _dividerFocused = focused),
              onKeyEvent: _handleDividerKey,
              child: Semantics(
                key: const ValueKey('macos-inspector-resize-divider'),
                container: true,
                slider: true,
                focusable: true,
                focused: _dividerFocused,
                label: 'Resize inspector',
                value: '${_width.round()} pixels wide',
                increasedValue: _width < widget.maxWidth
                    ? '${(_width + _keyboardStep).clamp(widget.minWidth, widget.maxWidth).round()} pixels wide'
                    : null,
                decreasedValue: _width > widget.minWidth
                    ? '${(_width - _keyboardStep).clamp(widget.minWidth, widget.maxWidth).round()} pixels wide'
                    : null,
                hint: 'Use the Left and Right Arrow keys to resize.',
                minValue: '${widget.minWidth.round()} pixels wide',
                maxValue: '${widget.maxWidth.round()} pixels wide',
                onFocus: _dividerFocusNode.requestFocus,
                onIncrease: _width < widget.maxWidth
                    ? () => _adjustWidth(_keyboardStep)
                    : null,
                onDecrease: _width > widget.minWidth
                    ? () => _adjustWidth(-_keyboardStep)
                    : null,
                child: MouseRegion(
                  cursor: SystemMouseCursors.resizeColumn,
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: _dividerFocusNode.requestFocus,
                    onHorizontalDragStart: (_) =>
                        _dividerFocusNode.requestFocus(),
                    onHorizontalDragUpdate: (details) =>
                        _adjustWidth(-details.delta.dx),
                    child: SizedBox(
                      width: 9,
                      child: Center(
                        child: Container(
                          width: _dividerFocused ? 2 : 1,
                          color: _dividerFocused
                              ? Theme.of(context).colorScheme.primary
                              : mac.divider,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
            SizedBox(
              key: const ValueKey('macos-inspector-pane'),
              width: _width,
              child: DecoratedBox(
                decoration: BoxDecoration(color: mac.sidebar),
                child: widget.inspector,
              ),
            ),
          ],
        );
      },
    );
  }

  KeyEventResult _handleDividerKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final delta = switch (event.logicalKey) {
      LogicalKeyboardKey.arrowLeft ||
      LogicalKeyboardKey.arrowUp => _keyboardStep,
      LogicalKeyboardKey.arrowRight ||
      LogicalKeyboardKey.arrowDown => -_keyboardStep,
      _ => null,
    };
    if (delta == null) return KeyEventResult.ignored;
    _adjustWidth(delta);
    return KeyEventResult.handled;
  }

  void _adjustWidth(double delta) {
    final next = (_width + delta).clamp(widget.minWidth, widget.maxWidth);
    if (next == _width) return;
    setState(() => _width = next);
  }

  Widget bodyWithInspectorSheet(BuildContext context) => Stack(
    children: [
      Positioned.fill(child: widget.body),
      Positioned(
        right: 14,
        bottom: 14,
        child: FloatingActionButton.small(
          tooltip: 'Open inspector',
          onPressed: () => showModalBottomSheet<void>(
            context: context,
            showDragHandle: true,
            isScrollControlled: true,
            constraints: const BoxConstraints(maxWidth: 640),
            builder: (_) => SafeArea(
              child: SizedBox(
                height: MediaQuery.sizeOf(context).height * .7,
                child: widget.inspector,
              ),
            ),
          ),
          child: const Icon(Icons.view_sidebar_outlined),
        ),
      ),
    ],
  );
}

class MacosPane extends StatelessWidget {
  const MacosPane({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.backgroundColor,
    this.borderRadius = 10,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final Color? backgroundColor;
  final double borderRadius;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        color: backgroundColor ?? Theme.of(context).colorScheme.surface,
        borderRadius: BorderRadius.circular(borderRadius),
        border: Border.all(color: mac.divider),
      ),
      child: Padding(padding: padding, child: child),
    );
  }
}

class MacosSectionHeader extends StatelessWidget {
  const MacosSectionHeader({
    super.key,
    required this.title,
    this.description,
    this.trailing,
  });

  final String title;
  final String? description;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            if (description != null) ...[
              const SizedBox(height: 3),
              Text(
                description!,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ],
        ),
      ),
      if (trailing != null) ...[const SizedBox(width: 12), trailing!],
    ],
  );
}

class MacosEmptyState extends StatelessWidget {
  const MacosEmptyState({
    super.key,
    required this.icon,
    required this.title,
    required this.message,
    this.action,
  });

  final IconData icon;
  final String title;
  final String message;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Center(
    child: ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 420),
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              icon,
              size: 34,
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
            const SizedBox(height: 14),
            Text(
              title,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 6),
            Text(
              message,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            if (action != null) ...[const SizedBox(height: 18), action!],
          ],
        ),
      ),
    ),
  );
}

class MacosLoadingList extends StatelessWidget {
  const MacosLoadingList({super.key, this.rows = 7});

  final int rows;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return ListView.separated(
      padding: const EdgeInsets.all(18),
      itemCount: rows,
      separatorBuilder: (_, _) => const SizedBox(height: 8),
      itemBuilder: (_, index) => Container(
        height: index == 0 ? 58 : 48,
        decoration: BoxDecoration(
          color: mac.hover,
          borderRadius: BorderRadius.circular(8),
        ),
      ),
    );
  }
}
