import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../builder/builder_controller.dart';
import '../builder/builder_providers.dart';
import '../builder/native_builder_view.dart';

/// Reuses Builder's scoped controller and encrypted draft recovery. Closing the
/// Assistant inspector must flush edits before its auto-disposed provider exits.
class AssistantCodingWorkspace extends ConsumerStatefulWidget {
  const AssistantCodingWorkspace({
    super.key,
    required this.projectId,
    required this.desktop,
  });
  final String projectId;
  final bool desktop;

  @override
  ConsumerState<AssistantCodingWorkspace> createState() =>
      _AssistantCodingWorkspaceState();
}

class _AssistantCodingWorkspaceState
    extends ConsumerState<AssistantCodingWorkspace> {
  bool closing = false;
  final messages = GlobalKey<ScaffoldMessengerState>();

  Future<void> close(BuilderController controller) async {
    if (closing || controller.acting) return;
    setState(() => closing = true);
    try {
      if (controller.localRecoveryPending) await controller.persist();
      if (!mounted) return;
      if (controller.localRecoveryPending) {
        throw StateError(
          'Your file draft could not be saved on this device. Keep the workspace open and try again.',
        );
      }
      // Let PopScope observe the flushed state before requesting the pop.
      await WidgetsBinding.instance.endOfFrame;
      if (mounted) Navigator.of(context).pop();
    } catch (_) {
      if (mounted) {
        messages.currentState?.showSnackBar(
          const SnackBar(
            content: Text(
              'Your file draft could not be saved on this device. Keep the workspace open and try again.',
            ),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => closing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final controller = ref.watch(builderControllerProvider(widget.projectId));
    final content = PopScope(
      canPop: !controller.acting && !controller.localRecoveryPending,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) close(controller);
      },
      child: ScaffoldMessenger(
        key: messages,
        child: Scaffold(
          appBar: AppBar(
            title: const Text('Files & changes'),
            automaticallyImplyLeading: false,
            actions: [
              IconButton(
                tooltip: controller.acting
                    ? 'Wait for the current action to finish'
                    : 'Close coding workspace',
                onPressed: closing || controller.acting
                    ? null
                    : () => close(controller),
                icon: const Icon(Icons.close_rounded),
              ),
            ],
          ),
          body: NativeBuilderView(
            projectId: widget.projectId,
            controller: controller,
            desktop: widget.desktop,
          ),
        ),
      ),
    );
    return widget.desktop
        ? Dialog(
            child: SizedBox(
              width: 1200,
              height: MediaQuery.sizeOf(context).height * .88,
              child: content,
            ),
          )
        : Dialog.fullscreen(child: content);
  }
}
