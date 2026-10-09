import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'companion_controller.dart';
import 'companion_models.dart';
import 'companion_personality_settings.dart';
import 'companion_presence.dart';
import 'companion_presentation.dart';
import 'companion_providers.dart';
import 'voice_appearance_settings.dart';

class CompanionSettingsSection extends ConsumerWidget {
  const CompanionSettingsSection({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) => CompanionSettingsEditor(
    key: ValueKey(ref.watch(companionScopeProvider)),
    controller: ref.watch(companionControllerProvider),
  );
}

class CompanionSettingsEditor extends StatefulWidget {
  const CompanionSettingsEditor({super.key, required this.controller});
  final CompanionController controller;
  @override
  State<CompanionSettingsEditor> createState() =>
      _CompanionSettingsEditorState();
}

class _CompanionSettingsEditorState extends State<CompanionSettingsEditor> {
  final saveFocus = FocusNode(debugLabel: 'Save Companion preferences');
  final resetFocus = FocusNode(debugLabel: 'Reset Companion preferences');
  final discardFocus = FocusNode(debugLabel: 'Discard Companion draft');
  final pickerFocus = FocusNode(debugLabel: 'Choose home conversation');
  final refreshFocus = FocusNode(debugLabel: 'Refresh Companion preferences');
  bool pickerOpen = false;
  @override
  void dispose() {
    saveFocus.dispose();
    resetFocus.dispose();
    discardFocus.dispose();
    pickerFocus.dispose();
    refreshFocus.dispose();
    super.dispose();
  }

  Future<void> _confirm({required bool reset}) async {
    final controller = widget.controller;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(
          reset
              ? 'Reset Companion preferences?'
              : 'Discard unsaved Companion draft?',
        ),
        content: Text(
          reset
              ? 'Save Balanced, visible, Full motion, Assistant entry, and no preferred home conversation. Other settings and conversations stay as they are.'
              : 'Replace your local draft with the current saved revision. This does not write to the server.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Keep draft'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(reset ? 'Reset preferences' : 'Discard draft'),
          ),
        ],
      ),
    );
    if (!mounted || !identical(controller, widget.controller)) return;
    if (confirmed == true) {
      if (reset) {
        await controller.save(reset: true);
      } else {
        controller.discardDraft();
      }
    }
    if (mounted) {
      (reset
              ? resetFocus
              : confirmed == true
              ? refreshFocus
              : discardFocus)
          .requestFocus();
    }
  }

  Widget _choices(
    String label,
    String selected,
    Map<String, String> values,
    bool enabled,
    void Function(String) update,
  ) => Padding(
    padding: const EdgeInsets.only(top: 16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 6),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final entry in values.entries)
              Semantics(
                selected: entry.key == selected,
                child: OutlinedButton(
                  key: ValueKey('companion-$label-${entry.key}'),
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size(48, 48),
                    backgroundColor: selected == entry.key
                        ? Theme.of(context).colorScheme.secondaryContainer
                        : null,
                  ),
                  onPressed: enabled ? () => update(entry.key) : null,
                  child: Text(entry.value),
                ),
              ),
          ],
        ),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final c = widget.controller;
      final draft = c.draft ?? const CompanionPreferences();
      final editable = c.draft != null;
      final current = c.current;
      return Container(
        key: const ValueKey('companion-settings'),
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          border: Border.all(
            color: Theme.of(context).colorScheme.outlineVariant,
          ),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Companion',
              style: TextStyle(fontSize: 24, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 8),
            const Text(
              'Make ATLAS feel right for you, and choose where Asael opens.',
              style: TextStyle(fontSize: 16, height: 1.5),
            ),
            const SizedBox(height: 12),
            const VoiceAppearanceSettings(),
            const SizedBox(height: 24),
            const CompanionPersonalitySettings(),
            const SizedBox(height: 24),
            Text(
              current == null
                  ? (c.loading
                        ? 'Loading saved preferences…'
                        : 'Saved preferences have not loaded.')
                  : 'Saved revision ${current.revision}${current.persisted ? '' : ' · defaults, not yet saved'}',
              style: const TextStyle(fontSize: 13),
            ),
            if (current?.updatedAt != null)
              Text(
                'Updated ${current!.updatedAt}',
                style: const TextStyle(fontSize: 13),
              ),
            if (c.readError != null)
              Text(c.readError!, style: const TextStyle(fontSize: 14)),
            if (c.policy?.active != true)
              Text(
                c.policy?.reason ?? 'Save access is not confirmed.',
                style: const TextStyle(fontSize: 13),
              ),
            TextButton(
              focusNode: refreshFocus,
              onPressed: c.loading || c.writing ? null : c.refresh,
              style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
              child: Text(
                c.loading ? 'Refreshing preferences…' : 'Refresh preferences',
              ),
            ),
            _choices(
              'Intensity',
              draft.intensity,
              {
                'quiet': 'Quiet',
                'balanced': 'Balanced',
                'expressive': 'Expressive',
              },
              editable,
              (value) => c.edit(draft.copyWith(intensity: value)),
            ),
            SwitchListTile.adaptive(
              contentPadding: EdgeInsets.zero,
              title: const Text('Show ATLAS character'),
              subtitle: const Text(
                'Status and controls stay available when the character is hidden.',
              ),
              value: draft.visible,
              onChanged: editable
                  ? (value) => c.edit(draft.copyWith(visible: value))
                  : null,
            ),
            _choices(
              'Motion',
              draft.motion,
              {'full': 'Full', 'reduced': 'Reduced', 'off': 'Off'},
              editable,
              (value) => c.edit(draft.copyWith(motion: value)),
            ),
            const SizedBox(height: 6),
            Text(
              MediaQuery.disableAnimationsOf(context)
                  ? 'System Reduce Motion is active and takes precedence. ATLAS uses a static portrait.'
                  : 'During voice conversations, Balanced and Expressive bring ATLAS to life as you listen and speak. Quiet, Reduced and Off keep the character still. System Reduce Motion and Low Power Mode take priority. ATLAS rests between interactions.',
              style: const TextStyle(fontSize: 13),
            ),
            _choices(
              'Default destination',
              draft.defaultDestination,
              {
                'assistant': 'Assistant',
                'today': 'Today',
                'activity': 'History',
                'work': 'Work',
              },
              editable,
              (value) => c.edit(draft.copyWith(defaultDestination: value)),
            ),
            const SizedBox(height: 16),
            const Text(
              'Home conversation',
              style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
            ),
            SelectableText(
              draft.preferredThreadId ?? 'No preferred home conversation.',
              style: const TextStyle(fontSize: 14),
            ),
            if (current != null)
              Text(switch (current.homeState) {
                'available' => 'Saved home is available to this account.',
                'unavailable' => 'Saved home is unavailable. Assistant entry falls back to Conversation; the saved choice is retained.',
                'unconfirmed' => 'Saved home could not be checked. Assistant entry falls back to Conversation; the saved choice is retained.',
                _ => 'Assistant entry opens Conversation with its existing history controls.',
              }, style: const TextStyle(fontSize: 13)),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                OutlinedButton(
                  focusNode: pickerFocus,
                  onPressed: !editable
                      ? null
                      : () {
                          setState(() => pickerOpen = !pickerOpen);
                          if (pickerOpen) c.loadConversations();
                        },
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size(48, 48),
                  ),
                  child: Text(
                    pickerOpen
                        ? 'Close conversation choices'
                        : 'Choose home conversation',
                  ),
                ),
                TextButton(
                  onPressed: editable && draft.preferredThreadId != null
                      ? () => c.edit(draft.copyWith(clearThread: true))
                      : null,
                  style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
                  child: const Text('Clear home choice'),
                ),
              ],
            ),
            if (pickerOpen) ...[
              const SizedBox(height: 8),
              const Text(
                'Up to 100 current owned conversations. Choosing one changes only this unsaved draft.',
                style: TextStyle(fontSize: 13),
              ),
              if (c.loadingConversations)
                const Text('Loading owned conversations…'),
              if (c.conversationError != null) Text(c.conversationError!),
              if (c.threads?.isEmpty == true)
                const Text(
                  'No eligible owned conversations in this loaded view.',
                ),
              if (c.omittedThreads > 0)
                Text(
                  '${c.omittedThreads} unavailable or ambiguous rows omitted.',
                ),
              for (final thread in c.threads ?? <CompanionConversation>[])
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: OutlinedButton(
                    onPressed: editable
                        ? () {
                            c.edit(
                              draft.copyWith(preferredThreadId: thread.id),
                            );
                            setState(() => pickerOpen = false);
                            pickerFocus.requestFocus();
                          }
                        : null,
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size(48, 48),
                      alignment: Alignment.centerLeft,
                      padding: const EdgeInsets.all(12),
                    ),
                    child: SizedBox(
                      width: double.infinity,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            thread.title,
                            style: const TextStyle(fontSize: 16),
                          ),
                          Text(thread.id, style: const TextStyle(fontSize: 13)),
                          Text(
                            '${thread.mode} · ${thread.updatedAt}',
                            style: const TextStyle(fontSize: 13),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              TextButton(
                onPressed: c.loadingConversations ? null : c.loadConversations,
                child: const Text('Refresh conversation choices'),
              ),
            ],
            const SizedBox(height: 16),
            const Text(
              'Presentation preview · no work or audio starts',
              style: TextStyle(fontSize: 13),
            ),
            CompanionPresence(preferences: draft, work: availableCompanion),
            const SizedBox(height: 12),
            Text(
              c.dirty
                  ? 'Unsaved draft'
                  : 'Draft matches the current saved preferences.',
              style: const TextStyle(fontSize: 14),
            ),
            if (c.staleRevision) ...[
              Text(
                'Your draft uses revision ${c.draftRevision}; the server is now at ${current!.revision}. Review before another save.',
              ),
              OutlinedButton(
                onPressed: c.writing || c.submission != null
                    ? null
                    : c.reviewAgainstCurrent,
                child: const Text('Keep draft against current revision'),
              ),
            ],
            if (c.writeError != null)
              Text(c.writeError!, style: const TextStyle(fontSize: 14)),
            if (c.receipt != null) ...[
              Text(
                'Save confirmed · ${c.receipt!.outcome} revision ${c.receipt!.revision}',
                style: const TextStyle(fontSize: 14),
              ),
              SelectableText(
                c.receipt!.id,
                style: const TextStyle(fontSize: 13),
              ),
              if (current != null && current.revision > c.receipt!.revision)
                Text(
                  'The confirmed receipt predates current saved revision ${current.revision}.',
                  style: const TextStyle(fontSize: 13),
                ),
            ],
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                FilledButton(
                  focusNode: saveFocus,
                  onPressed: c.canSubmit && c.dirty ? c.save : null,
                  style: FilledButton.styleFrom(
                    minimumSize: const Size(48, 48),
                  ),
                  child: Text(
                    c.writing ? 'Saving preferences…' : 'Save preferences',
                  ),
                ),
                if (c.submission != null)
                  OutlinedButton(
                    onPressed: c.canRetry ? c.retrySubmission : null,
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size(48, 48),
                    ),
                    child: const Text('Retry exact submission'),
                  ),
                TextButton(
                  focusNode: discardFocus,
                  onPressed: c.dirty && !c.writing && c.submission == null
                      ? () => _confirm(reset: false)
                      : null,
                  style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
                  child: const Text('Discard draft'),
                ),
                TextButton(
                  focusNode: resetFocus,
                  onPressed: c.canSubmit ? () => _confirm(reset: true) : null,
                  style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
                  child: const Text('Reset preferences'),
                ),
              ],
            ),
          ],
        ),
      );
    },
  );
}
