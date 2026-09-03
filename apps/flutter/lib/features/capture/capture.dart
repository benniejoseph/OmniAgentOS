import 'dart:typed_data';

import 'package:flutter/material.dart';

class CaptureDraft {
  const CaptureDraft({
    required this.content,
    this.title = '',
    this.tags = const [],
    this.file,
  });
  final String content, title;
  final List<String> tags;
  final CaptureAttachment? file;
  bool get valid => content.trim().isNotEmpty || file != null;
}

class CaptureAttachment {
  const CaptureAttachment({
    required this.name,
    required this.bytes,
    required this.contentType,
  });
  final String name, contentType;
  final Uint8List bytes;
}

class CaptureReceipt {
  const CaptureReceipt({
    required this.jobId,
    required this.title,
    required this.tags,
  });
  final String jobId, title;
  final List<String> tags;
}

abstract interface class CaptureRepository {
  Future<CaptureReceipt> submit(
    CaptureDraft draft, {
    required String idempotencyKey,
  });
}

class CaptureController extends ChangeNotifier {
  CaptureController(this.repository);
  final CaptureRepository repository;
  bool submitting = false;
  Object? error;
  CaptureReceipt? receipt;
  Future<bool> submit(CaptureDraft draft) async {
    if (!draft.valid || submitting) return false;
    submitting = true;
    error = null;
    notifyListeners();
    try {
      receipt = await repository.submit(
        draft,
        idempotencyKey: 'capture-${DateTime.now().microsecondsSinceEpoch}',
      );
      return true;
    } catch (e) {
      error = e;
      return false;
    } finally {
      submitting = false;
      notifyListeners();
    }
  }
}

class CaptureView extends StatefulWidget {
  const CaptureView({super.key, required this.controller});
  final CaptureController controller;
  @override
  State<CaptureView> createState() => _CaptureViewState();
}

class _CaptureViewState extends State<CaptureView> {
  final title = TextEditingController(),
      note = TextEditingController(),
      tags = TextEditingController();
  @override
  void dispose() {
    title.dispose();
    note.dispose();
    tags.dispose();
    super.dispose();
  }

  Future<void> submit() async {
    final ok = await widget.controller.submit(
      CaptureDraft(
        title: title.text,
        content: note.text,
        tags: tags.text
            .split(',')
            .map((e) => e.trim())
            .where((e) => e.isNotEmpty)
            .toList(),
      ),
    );
    if (ok && mounted) {
      title.clear();
      note.clear();
      tags.clear();
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Capture queued for your knowledge base')),
      );
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Capture')),
    body: ListenableBuilder(
      listenable: widget.controller,
      builder: (_, _) => LayoutBuilder(
        builder: (context, constraints) {
          final wide = constraints.maxWidth >= 800;
          final form = <Widget>[
            Text(
              'Capture what matters',
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            const SizedBox(height: 8),
            Text(
              'Notes are queued, indexed, and kept searchable with their source.',
              style: Theme.of(context).textTheme.bodyLarge,
            ),
            const SizedBox(height: 24),
            TextField(
              controller: title,
              decoration: const InputDecoration(
                labelText: 'Title',
                helperText: 'Optional, a title is generated when left empty',
                prefixIcon: Icon(Icons.title_rounded),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: note,
              minLines: 7,
              maxLines: 16,
              autofocus: true,
              decoration: const InputDecoration(
                labelText: 'Note',
                hintText:
                    'Paste a thought, link, meeting note, or research fragment',
                alignLabelWithHint: true,
                prefixIcon: Padding(
                  padding: EdgeInsets.only(bottom: 120),
                  child: Icon(Icons.edit_note_rounded),
                ),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: tags,
              decoration: const InputDecoration(
                labelText: 'Tags',
                hintText: 'research, launch, idea',
                prefixIcon: Icon(Icons.tag_rounded),
              ),
            ),
            if (widget.controller.error != null)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(
                  'Could not queue this capture. Your draft is still here.',
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            const SizedBox(height: 20),
            FilledButton.icon(
              onPressed: widget.controller.submitting ? null : submit,
              icon: widget.controller.submitting
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.bolt_rounded),
              label: Text(
                widget.controller.submitting
                    ? 'Saving capture…'
                    : 'Save capture',
              ),
            ),
          ];
          final receipt = AnimatedSwitcher(
            duration: const Duration(milliseconds: 220),
            switchInCurve: Curves.easeOutCubic,
            child: widget.controller.receipt == null
                ? const _CaptureGuide(key: ValueKey('guide'))
                : _CaptureSuccess(
                    key: const ValueKey('success'),
                    receipt: widget.controller.receipt!,
                  ),
          );
          return SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 1080),
                child: wide
                    ? Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            flex: 3,
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: form,
                            ),
                          ),
                          const SizedBox(width: 28),
                          Expanded(flex: 2, child: receipt),
                        ],
                      )
                    : Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          ...form,
                          const SizedBox(height: 24),
                          receipt,
                        ],
                      ),
              ),
            ),
          );
        },
      ),
    ),
  );
}

class _CaptureGuide extends StatelessWidget {
  const _CaptureGuide({super.key});
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(20),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surfaceContainerLow,
      borderRadius: BorderRadius.circular(16),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(Icons.hub_outlined, color: Theme.of(context).colorScheme.primary),
        const SizedBox(height: 16),
        Text(
          'What happens next',
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 12),
        const _GuideRow(
          icon: Icons.cloud_upload_outlined,
          text: 'Queued safely for processing',
        ),
        const _GuideRow(
          icon: Icons.manage_search_rounded,
          text: 'Indexed for semantic search',
        ),
        const _GuideRow(
          icon: Icons.link_rounded,
          text: 'Connected to related knowledge',
        ),
      ],
    ),
  );
}

class _GuideRow extends StatelessWidget {
  const _GuideRow({required this.icon, required this.text});
  final IconData icon;
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 7),
    child: Row(
      children: [
        Icon(icon, size: 19),
        const SizedBox(width: 10),
        Expanded(child: Text(text)),
      ],
    ),
  );
}

class _CaptureSuccess extends StatelessWidget {
  const _CaptureSuccess({super.key, required this.receipt});
  final CaptureReceipt receipt;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(20),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.primaryContainer,
      borderRadius: BorderRadius.circular(16),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(
          Icons.check_circle_rounded,
          color: Theme.of(context).colorScheme.primary,
        ),
        const SizedBox(height: 14),
        Text('Capture queued', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 6),
        Text(
          receipt.title.isEmpty ? 'Your note is being indexed.' : receipt.title,
        ),
        if (receipt.tags.isNotEmpty) ...[
          const SizedBox(height: 14),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: receipt.tags
                .map(
                  (tag) => Chip(
                    label: Text(tag),
                    visualDensity: VisualDensity.compact,
                  ),
                )
                .toList(),
          ),
        ],
      ],
    ),
  );
}
