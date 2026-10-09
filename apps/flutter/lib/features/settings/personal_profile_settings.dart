import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'personal_profile_controller.dart';
import 'personal_profile_repository.dart';

class PersonalProfileSettings extends ConsumerWidget {
  const PersonalProfileSettings({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final controller = ref.watch(personalProfileControllerProvider);
    if (controller == null) return const SizedBox.shrink();
    return _PersonalProfileEditor(
      key: ObjectKey(controller),
      controller: controller,
    );
  }
}

class _PersonalProfileEditor extends StatefulWidget {
  const _PersonalProfileEditor({super.key, required this.controller});
  final PersonalProfileController controller;
  @override
  State<_PersonalProfileEditor> createState() => _PersonalProfileEditorState();
}

class _PersonalProfileEditorState extends State<_PersonalProfileEditor> {
  final _fields = <String, TextEditingController>{
    for (final field in personalProfileFields)
      field.key: TextEditingController(),
  };
  int _editorRevision = -1;
  bool _editing = false;

  @override
  void dispose() {
    for (final field in _fields.values) {
      field.dispose();
    }
    super.dispose();
  }

  Future<void> _reload() async {
    final c = widget.controller;
    if (c.dirty) {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Reload your saved profile?'),
          content: const Text(
            'This replaces your unsaved changes with the latest version saved to your account.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Keep changes'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Reload profile'),
            ),
          ],
        ),
      );
      if (!mounted ||
          !identical(c, widget.controller) ||
          !c.available ||
          confirmed != true)
        return;
    }
    await c.refresh();
  }

  Future<void> _forget() async {
    final c = widget.controller;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Clear your About me profile?'),
        content: const Text(
          'This removes these profile details from future conversations across your devices. Existing chats, saved memories and client documents stay in their own spaces.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Keep profile'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Clear profile'),
          ),
        ],
      ),
    );
    if (!mounted ||
        !identical(c, widget.controller) ||
        !c.editable ||
        confirmed != true)
      return;
    c.clearAll();
    await c.save();
  }

  String _date(DateTime value) {
    final local = value.toLocal();
    final material = MaterialLocalizations.of(context);
    return '${material.formatMediumDate(local)} at ${material.formatTimeOfDay(TimeOfDay.fromDateTime(local))}';
  }

  Widget _field(({String key, String label, String hint, int limit}) field) {
    final c = widget.controller;
    final theme = Theme.of(context);
    final source = c.saved?.sources[field.key];
    final empty = (c.draft[field.key] ?? '').isEmpty;
    final changed = c.draft[field.key] != c.saved?.profile[field.key];
    return Padding(
      padding: const EdgeInsets.only(top: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(field.label, style: theme.textTheme.titleSmall),
              ),
              if (!empty)
                IconButton(
                  key: ValueKey('about-me-clear-${field.key}'),
                  tooltip: 'Clear ${field.label.toLowerCase()}',
                  visualDensity: VisualDensity.compact,
                  onPressed: c.editable
                      ? () {
                          _fields[field.key]!.clear();
                          c.update(field.key, '');
                        }
                      : null,
                  icon: const Icon(Icons.close_rounded, size: 18),
                ),
            ],
          ),
          const SizedBox(height: 6),
          TextField(
            key: ValueKey('about-me-${field.key}'),
            controller: _fields[field.key],
            enabled: c.editable,
            minLines: 1,
            maxLines: field.key == 'name' ? 1 : 6,
            maxLength: field.limit,
            textCapitalization: field.key == 'name'
                ? TextCapitalization.words
                : TextCapitalization.sentences,
            onChanged: (value) => c.update(field.key, value),
            decoration: InputDecoration(
              hintText: field.hint,
              counterText: '',
              border: const OutlineInputBorder(),
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 12,
                vertical: 12,
              ),
            ),
          ),
          if (changed) ...[
            const SizedBox(height: 5),
            Text(
              empty ? 'Will be removed when you save' : 'Unsaved change',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ] else if (source != null) ...[
            const SizedBox(height: 5),
            Text(
              '${source.label} · ${_date(source.updatedAt)}',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ] else if (empty) ...[
            const SizedBox(height: 5),
            Text(
              'Not added yet',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _savedField(
    ({String key, String label, String hint, int limit}) field,
  ) {
    final saved = widget.controller.saved!;
    final value = saved.profile[field.key] ?? '';
    final source = saved.sources[field.key];
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(field.label, style: theme.textTheme.titleSmall),
          const SizedBox(height: 5),
          SelectableText(
            value.isEmpty ? 'Not added yet' : value,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: value.isEmpty ? theme.colorScheme.onSurfaceVariant : null,
              height: 1.5,
            ),
          ),
          if (source != null) ...[
            const SizedBox(height: 5),
            Text(
              '${source.label} · ${_date(source.updatedAt)}',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final c = widget.controller;
      if (!c.available) return const SizedBox.shrink();
      if (_editorRevision != c.editorRevision) {
        _editorRevision = c.editorRevision;
        for (final field in personalProfileFields) {
          _fields[field.key]!.text = c.draft[field.key] ?? '';
        }
      }
      final theme = Theme.of(context);
      final scheme = theme.colorScheme;
      return Container(
        key: const ValueKey('about-me-settings'),
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          border: Border.all(color: scheme.outlineVariant),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  Icons.person_outline_rounded,
                  color: scheme.primary,
                  size: 24,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'About me',
                    style: theme.textTheme.titleLarge?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                IconButton(
                  tooltip: 'Reload your saved profile',
                  onPressed: c.busy ? null : _reload,
                  icon: const Icon(Icons.refresh_rounded),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              'What ATLAS knows about you. Keep the details you want it to use accurate and in your own words.',
              style: theme.textTheme.bodyMedium,
            ),
            const SizedBox(height: 8),
            Text(
              'Shared across your devices. Conversation only includes this profile when enabled. Current message only, No extra context and Reviewed saved context leave it out.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: scheme.onSurfaceVariant,
              ),
            ),
            if (c.loading) ...[
              const SizedBox(height: 14),
              const LinearProgressIndicator(),
            ],
            if (c.saved != null) ...[
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  ChoiceChip(
                    label: const Text('What ATLAS knows'),
                    selected: !_editing,
                    onSelected: (_) => setState(() => _editing = false),
                  ),
                  ChoiceChip(
                    label: const Text('Edit profile'),
                    selected: _editing,
                    onSelected: (_) => setState(() => _editing = true),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              if (_editing)
                SwitchListTile.adaptive(
                  key: const ValueKey('about-me-enabled'),
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Use in conversations'),
                  subtitle: Text(
                    c.enabled
                        ? 'Use these details in text and new voice conversations after saving.'
                        : 'Keep these details saved without adding them to conversations.',
                  ),
                  value: c.enabled,
                  onChanged: c.editable ? c.setEnabled : null,
                )
              else
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(
                    c.saved!.enabled
                        ? Icons.check_circle_outline_rounded
                        : Icons.pause_circle_outline_rounded,
                    color: scheme.primary,
                  ),
                  title: Text(
                    c.saved!.enabled
                        ? 'Used in conversations'
                        : 'Saved without using in conversations',
                  ),
                  subtitle: const Text(
                    'These are your saved details. Profile changes apply to the next message or new voice conversation.',
                  ),
                ),
              const Divider(height: 16),
              if (c.saved!.revision == 0)
                Text(
                  'Start with a few details that would make ATLAS more useful to you.',
                  style: theme.textTheme.bodyMedium,
                ),
              for (final field in personalProfileFields)
                _editing ? _field(field) : _savedField(field),
              const SizedBox(height: 20),
              Text(
                'Work role notes, client documents, saved memories and connected mail stay in their own spaces. This profile does not connect an account or enable automatic memory recall.',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: scheme.onSurfaceVariant,
                ),
              ),
            ],
            if (c.error != null || c.notice != null) ...[
              const SizedBox(height: 14),
              Semantics(
                liveRegion: true,
                child: Text(
                  c.error ?? c.notice!,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: c.error != null ? scheme.error : scheme.onSurface,
                  ),
                ),
              ),
            ],
            const SizedBox(height: 16),
            Wrap(
              spacing: 10,
              runSpacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                if (c.saved != null && _editing)
                  FilledButton.icon(
                    key: const ValueKey('about-me-save'),
                    onPressed: c.canSave ? c.save : null,
                    icon: c.saving
                        ? const SizedBox.square(
                            dimension: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.check_rounded, size: 18),
                    label: Text(c.saving ? 'Saving…' : 'Save changes'),
                  ),
                if (c.reloadRequired || (c.error != null && c.saved == null))
                  OutlinedButton(
                    onPressed: c.busy ? null : _reload,
                    child: const Text('Reload saved profile'),
                  ),
                if (c.saved != null &&
                    (c.saved!.profile.values.any((value) => value.isNotEmpty) ||
                        c.draft.values.any((value) => value.isNotEmpty)))
                  TextButton.icon(
                    key: const ValueKey('about-me-forget'),
                    onPressed: c.editable ? _forget : null,
                    icon: const Icon(Icons.delete_outline_rounded, size: 18),
                    label: const Text('Clear profile'),
                  ),
                if (c.dirty)
                  Text(
                    'Unsaved changes',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                if (!c.dirty && c.saved?.updatedAt != null)
                  Text(
                    'Saved ${_date(c.saved!.updatedAt!)}',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
              ],
            ),
          ],
        ),
      );
    },
  );
}
