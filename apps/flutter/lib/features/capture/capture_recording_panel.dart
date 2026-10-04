import 'package:flutter/material.dart';

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
    builder: (context, _) => Material(
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
              Semantics(liveRegion: true, child: Text(controller.message!)),
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
                    onPressed: controller.busy ? null : controller.discard,
                    child: const Text('Discard recording'),
                  ),
                if (controller.attachment != null)
                  FilledButton.tonal(
                    onPressed: controller.capture.canWrite
                        ? () {
                            final attachment = controller.takeAttachment();
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
}
