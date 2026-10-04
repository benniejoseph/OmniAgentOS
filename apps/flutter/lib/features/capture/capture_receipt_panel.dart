import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../results/created_file_export.dart';
import 'capture_controller.dart';
import 'capture_projection.dart';

class CaptureReceiptPanel extends StatefulWidget {
  const CaptureReceiptPanel({
    super.key,
    required this.controller,
    this.onOpenKnowledge,
    this.exporter = const ScopedCreatedFileExporter(),
  });
  final CaptureController controller;
  final VoidCallback? onOpenKnowledge;
  final ScopedCreatedFileExporter exporter;
  @override
  State<CaptureReceiptPanel> createState() => _CaptureReceiptPanelState();
}

class _CaptureReceiptPanelState extends State<CaptureReceiptPanel> {
  bool _saving = false;
  String? _notice;
  @override
  void didUpdateWidget(covariant CaptureReceiptPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, widget.controller)) {
      _saving = false;
      _notice = null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller,
        receipt = controller.receipt,
        asset = controller.selectedAsset;
    return Material(
      color: Theme.of(context).colorScheme.surfaceContainerLow,
      borderRadius: BorderRadius.circular(12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Source and processing',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            if (receipt == null)
              const Text(
                'After the service accepts a capture, its exact source and job identities appear here.',
              ),
            if (receipt != null) ...[
              const SizedBox(height: 8),
              Text(receipt.title),
              const Text('Transfer accepted by the Capture service.'),
              SelectableText(
                'Job: ${receipt.jobId}\nStatus: ${controller.receiptJob?.status ?? receipt.jobStatus}${receipt.source == null ? '' : '\nSource: ${receipt.source}'}',
              ),
              Text(
                captureProcessingDescription(
                  const {'completed', 'failed', 'canceled'}.contains(
                        controller.receiptJob?.status ?? receipt.jobStatus,
                      )
                      ? controller.receiptJob?.status ?? receipt.jobStatus
                      : controller.receiptJob?.progressStage ??
                            receipt.progressStage,
                ),
              ),
              if (asset != null) ...[
                const SizedBox(height: 8),
                SelectableText(
                  'Original: ${asset.filename}\nAsset: ${asset.id}\n${asset.byteCount} bytes · ${asset.mediaType}\nContent SHA-256: ${asset.contentSha256}',
                ),
                Text(asset.extractionLabel),
                Text(asset.indexingLabel),
                if (!controller.assetFresh)
                  const Text(
                    'Original metadata has not been freshly verified. Refresh before saving.',
                  ),
                if (asset.error != null) SelectableText(asset.error!),
              ] else if (controller.receiptJob?.documentId != null)
                SelectableText(
                  'Returned document: ${controller.receiptJob!.documentId}',
                ),
              if (controller.receiptReadError != null)
                Semantics(
                  liveRegion: true,
                  child: Text(
                    'Current source state unavailable: ${controller.receiptReadError}',
                  ),
                ),
              if (_notice != null)
                Semantics(liveRegion: true, child: Text(_notice!)),
              const SizedBox(height: 12),
              Wrap(
                spacing: 12,
                runSpacing: 8,
                children: [
                  OutlinedButton.icon(
                    key: const Key('capture-refresh-receipt'),
                    onPressed:
                        controller.available && !controller.refreshingReceipt
                        ? controller.refreshReceipt
                        : null,
                    icon: const Icon(Icons.refresh),
                    label: Text(
                      controller.refreshingReceipt
                          ? 'Checking source…'
                          : 'Refresh source',
                    ),
                  ),
                  if (asset != null)
                    OutlinedButton.icon(
                      key: const Key('capture-save-original'),
                      onPressed:
                          controller.available &&
                              controller.assetFresh &&
                              asset.contentAvailable &&
                              widget.exporter.available &&
                              !_saving
                          ? () => _save(asset)
                          : null,
                      icon: const Icon(Icons.save_alt),
                      label: Text(
                        _saving ? 'Saving original…' : 'Save original as…',
                      ),
                    ),
                  if (receipt.source != null)
                    OutlinedButton.icon(
                      onPressed: controller.available
                          ? () async {
                              final generation = controller.generation;
                              if (!controller.current(generation)) {
                                return;
                              }
                              await Clipboard.setData(
                                ClipboardData(text: receipt.source!),
                              );
                              if (mounted &&
                                  identical(controller, widget.controller) &&
                                  controller.current(generation)) {
                                setState(
                                  () => _notice = 'Source citation copied.',
                                );
                              }
                            }
                          : null,
                      icon: const Icon(Icons.copy),
                      label: const Text('Copy source citation'),
                    ),
                ],
              ),
              if (asset != null && !widget.exporter.available)
                const Text('Saving originals is available in the desktop app.'),
            ],
            const SizedBox(height: 12),
            const Text(
              'Capture history, historical versions and reindexing are not available in this native view. A completed processing job does not establish complete extraction.',
            ),
            if (widget.onOpenKnowledge != null)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton(
                  onPressed: widget.onOpenKnowledge,
                  child: const Text('Open Knowledge'),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Future<void> _save(CaptureAssetSnapshot reviewed) async {
    final controller = widget.controller,
        generation = widget.controller.generation;
    bool current() =>
        mounted &&
        identical(controller, widget.controller) &&
        controller.current(generation) &&
        controller.assetFresh &&
        controller.selectedAsset?.contentIdentity == reviewed.contentIdentity;
    if (_saving || !current()) {
      return;
    }
    setState(() {
      _saving = true;
      _notice = null;
    });
    try {
      final outcome = await widget.exporter.save(
        filename: reviewed.filename,
        loadBytes: () => controller.downloadOriginal(reviewed),
        isCurrent: current,
      );
      if (current()) {
        setState(
          () => _notice = switch (outcome) {
            CreatedFileExportOutcome.saved => 'The exact original was saved.',
            CreatedFileExportOutcome.canceled =>
              'Save dialog closed. No original was saved.',
            CreatedFileExportOutcome.scopeChanged =>
              'Capture access changed. Refresh before saving again.',
            CreatedFileExportOutcome.unavailable =>
              'Saving originals is unavailable on this platform.',
          },
        );
      }
    } catch (_) {
      if (current()) {
        setState(
          () => _notice = 'The original could not be verified or saved. Refresh and try again.',
        );
      }
    } finally {
      if (mounted && identical(controller, widget.controller)) {
        setState(() => _saving = false);
      }
    }
  }
}
