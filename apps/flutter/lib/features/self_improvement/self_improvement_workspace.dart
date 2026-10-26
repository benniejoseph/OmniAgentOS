import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/network/native_workspace_access.dart';
import '../../generated/native_contract.g.dart';
import 'self_improvement_controller.dart';
import 'self_improvement_providers.dart';
import 'self_improvement_view.dart';

class NativeSelfImprovementPage extends StatefulWidget {
  const NativeSelfImprovementPage({super.key, this.cycleId});
  final String? cycleId;
  @override
  State<NativeSelfImprovementPage> createState() =>
      _NativeSelfImprovementPageState();
}

class _NativeSelfImprovementPageState extends State<NativeSelfImprovementPage>
    with WidgetsBindingObserver {
  bool _foreground = true;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    _foreground = lifecycle == null || lifecycle == AppLifecycleState.resumed;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final foreground = state == AppLifecycleState.resumed;
    if (_foreground != foreground) setState(() => _foreground = foreground);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (widget.cycleId != null &&
        !RegExp(r'^self_cycle_[a-f0-9]{64}$').hasMatch(widget.cycleId!)) {
      return const Center(child: Text('This improvement link is invalid.'));
    }
    if (!NativeContract.supportsOperation('selfImprovement.get')) {
      return const Center(
        child: Text('Update Asael to use the native improvement workspace.'),
      );
    }
    return NativePrivateWorkspace(
      builder: (access) => _SelfImprovementScope(
        key: ValueKey(access.identity),
        cycleId: widget.cycleId,
        visible: _foreground && TickerMode.valuesOf(context).enabled,
      ),
    );
  }
}

class _SelfImprovementScope extends ConsumerStatefulWidget {
  const _SelfImprovementScope({super.key, this.cycleId, required this.visible});
  final String? cycleId;
  final bool visible;
  @override
  ConsumerState<_SelfImprovementScope> createState() =>
      _SelfImprovementScopeState();
}

class _SelfImprovementScopeState extends ConsumerState<_SelfImprovementScope> {
  SelfImprovementController? _controller;
  Timer? _timer;
  DateTime? _hiddenAt;
  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 30), (_) {
      final controller = _controller;
      if (mounted &&
          widget.visible &&
          controller != null &&
          controller.current &&
          !controller.loading &&
          !controller.acting &&
          !controller.setupLoading &&
          !controller.refreshRequired &&
          TickerMode.valuesOf(context).enabled &&
          WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed) {
        unawaited(controller.refresh());
      }
    });
  }

  @override
  void didUpdateWidget(covariant _SelfImprovementScope oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!widget.visible && oldWidget.visible) _hiddenAt = DateTime.now();
    final needsResumeRead =
        widget.visible &&
        !oldWidget.visible &&
        (_controller?.snapshot == null ||
            _controller?.refreshRequired == true ||
            _hiddenAt != null &&
                DateTime.now().difference(_hiddenAt!) >=
                    const Duration(seconds: 30));
    if (oldWidget.cycleId != widget.cycleId || needsResumeRead) _load();
  }

  void _load() {
    final controller = _controller;
    if (controller == null || !widget.visible) return;
    unawaited(
      Future<void>.microtask(() async {
        if (mounted && widget.visible && identical(controller, _controller)) {
          await controller.refresh(cycleId: widget.cycleId);
        }
      }),
    );
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = ref.watch(selfImprovementControllerProvider);
    if (!identical(controller, _controller)) {
      _controller = controller;
      _load();
    }
    return SelfImprovementView(
      controller: controller,
      cycleId: widget.cycleId,
      onOpenRun: (runId) =>
          context.push('/results/${Uri.encodeComponent('agent:$runId')}'),
    );
  }
}
