import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'companion_providers.dart';

/// Used only for an ordinary launch without an explicit safe destination.
/// A late preference read never redirects a surface the user already opened.
class CompanionDefaultEntry extends ConsumerStatefulWidget {
  const CompanionDefaultEntry({super.key, required this.fallback});
  final String fallback;
  @override
  ConsumerState<CompanionDefaultEntry> createState() =>
      _CompanionDefaultEntryState();
}

class _CompanionDefaultEntryState extends ConsumerState<CompanionDefaultEntry> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(_open());
    });
  }

  Future<void> _open() async {
    final scope = ref.read(companionScopeProvider);
    final controller = ref.read(companionControllerProvider);
    var location = widget.fallback;
    try {
      await controller.refresh().timeout(const Duration(seconds: 4));
      if (!controller.disposed &&
          controller.readError == null &&
          controller.current != null) {
        location = controller.current!.nativeDestination;
      }
    } catch (_) {
      /* The established platform entry remains available. */
    }
    if (!mounted ||
        scope != ref.read(companionScopeProvider) ||
        GoRouterState.of(context).uri.path != '/companion-entry') {
      return;
    }
    context.go(location);
  }

  @override
  Widget build(BuildContext context) => const Scaffold(
    body: SafeArea(
      child: Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text('Opening your saved destination…'),
        ),
      ),
    ),
  );
}
