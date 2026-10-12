import 'package:flutter/material.dart';

import '../../app/mobile/mobile_page_scaffold.dart';
import '../../app/platform/mobile_presentation.dart';
import 'capture_models.dart';
import 'capture_recording.dart';

class CaptureRecordingPanel extends StatelessWidget {
  const CaptureRecordingPanel({
    super.key,
    required this.controller,
    required this.onAttach,
  });
  final CaptureRecordingController controller;
  final ValueChanged<CaptureAttachment> onAttach;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) => usesMobilePresentation()
        ? _mobile(context)
        : Material(
            color: Theme.of(context).colorScheme.surfaceContainerLow,
            borderRadius: BorderRadius.circular(12),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'Record an audio note',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const Text(
                    'Up to 2 minutes. Audio stays on this device until you attach and save it. Shared links remain note text.',
                  ),
                  CheckboxListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Everyone being recorded has agreed.'),
                    value: controller.consent,
                    onChanged:
                        controller.busy ||
                            controller.microphoneActive ||
                            !controller.capture.canWrite
                        ? null
                        : (value) => controller.setConsent(value == true),
                  ),
                  Semantics(
                    liveRegion: true,
                    child: Text(switch (controller.phase) {
                      CaptureRecordingPhase.requestingPermission =>
                        'Waiting for microphone permission…',
                      CaptureRecordingPhase.starting => 'Starting microphone…',
                      CaptureRecordingPhase.stopping =>
                        'Stopping and finalizing audio…',
                      _ =>
                        !controller.microphoneStateKnown
                            ? 'Microphone state unknown'
                            : controller.microphoneActive
                            ? controller.deadlineExceeded
                                  ? 'Microphone active · time limit exceeded'
                                  : 'Microphone active · recording'
                            : 'Microphone inactive',
                    }),
                  ),
                  if (controller.message != null)
                    Semantics(
                      liveRegion: true,
                      child: Text(controller.message!),
                    ),
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 12,
                    runSpacing: 8,
                    children: [
                      FilledButton.icon(
                        key: const Key('capture-record-start-stop'),
                        onPressed: controller.busy
                            ? null
                            : controller.microphoneActive
                            ? controller.stop
                            : controller.canStart
                            ? controller.start
                            : null,
                        icon: Icon(
                          controller.microphoneActive
                              ? Icons.stop_rounded
                              : Icons.mic_none_rounded,
                        ),
                        label: Text(
                          controller.microphoneActive
                              ? 'Stop recording'
                              : 'Start recording',
                        ),
                      ),
                      if (controller.microphoneActive ||
                          !controller.microphoneStateKnown ||
                          controller.deadlineExceeded ||
                          controller.attachment != null)
                        OutlinedButton(
                          onPressed: controller.busy
                              ? null
                              : controller.discard,
                          child: const Text('Discard recording'),
                        ),
                      if (controller.attachment != null)
                        FilledButton.tonal(
                          onPressed: controller.capture.canWrite
                              ? () {
                                  final attachment = controller
                                      .takeAttachment();
                                  if (attachment != null) onAttach(attachment);
                                }
                              : null,
                          child: const Text('Attach audio note'),
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ),
  );

  Widget _mobile(BuildContext context) {
    final active = controller.microphoneActive;
    final status = switch (controller.phase) {
      CaptureRecordingPhase.requestingPermission =>
        'Allow your microphone to continue',
      CaptureRecordingPhase.starting => 'Starting your recording…',
      CaptureRecordingPhase.stopping => 'Finishing your audio note…',
      _ =>
        !controller.microphoneStateKnown
            ? 'Check microphone access'
            : active
            ? controller.deadlineExceeded
                  ? 'Time limit reached · stop recording'
                  : 'Recording your note'
            : controller.attachment != null
            ? 'Your recording is ready'
            : 'A thought, in your own voice',
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        MobileSurface(
          spotlight: true,
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
          child: Column(
            children: [
              Icon(
                active ? Icons.mic_rounded : Icons.mic_none_rounded,
                size: 52,
              ),
              const SizedBox(height: 20),
              Semantics(
                liveRegion: true,
                child: Text(
                  status,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontSize: 21,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                'Up to 2 minutes · saved on this phone first',
                textAlign: TextAlign.center,
              ),
              if (controller.busy) ...[
                const SizedBox(height: 20),
                const SizedBox.square(
                  dimension: 22,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: 16),
        CheckboxListTile(
          contentPadding: EdgeInsets.zero,
          controlAffinity: ListTileControlAffinity.leading,
          title: const Text('Everyone being recorded has agreed'),
          subtitle: const Text(
            'Audio is only uploaded after you attach and save it.',
          ),
          value: controller.consent,
          onChanged: controller.busy || active || !controller.capture.canWrite
              ? null
              : (value) => controller.setConsent(value == true),
        ),
        if (controller.message != null)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Semantics(
              liveRegion: true,
              child: Text(controller.message!),
            ),
          ),
        const SizedBox(height: 12),
        if (controller.attachment != null && !active && !controller.busy)
          FilledButton.icon(
            onPressed: controller.capture.canWrite
                ? () {
                    final attachment = controller.takeAttachment();
                    if (attachment != null) onAttach(attachment);
                  }
                : null,
            icon: const Icon(Icons.check_rounded),
            label: const Text('Use this recording'),
          )
        else
          FilledButton.icon(
            key: const Key('capture-record-start-stop'),
            onPressed: controller.busy
                ? null
                : active
                ? controller.stop
                : controller.canStart
                ? controller.start
                : null,
            icon: Icon(active ? Icons.stop_rounded : Icons.mic_rounded),
            label: Text(active ? 'Stop recording' : 'Start recording'),
          ),
        if (active ||
            !controller.microphoneStateKnown ||
            controller.deadlineExceeded ||
            controller.attachment != null)
          TextButton.icon(
            onPressed: controller.busy ? null : controller.discard,
            icon: const Icon(Icons.delete_outline_rounded),
            label: const Text('Discard recording'),
          ),
      ],
    );
  }
}
