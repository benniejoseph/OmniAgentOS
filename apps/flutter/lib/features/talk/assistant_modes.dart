import 'package:flutter/material.dart';

import '../../app/platform/macos_presentation.dart';
export '../../core/network/assistant_mode_contract.dart';

enum AssistantMode {
  chat,
  cowork,
  coding;

  static AssistantMode fromWire(String value) => switch (value) {
    'chat' || 'learn' => chat,
    'coding' => coding,
    _ => cowork,
  };

  String get label => switch (this) {
    chat => 'Chat',
    cowork => 'Cowork',
    coding => 'Coding',
  };
  IconData get icon => switch (this) {
    chat => Icons.chat_bubble_outline_rounded,
    cowork => Icons.work_outline_rounded,
    coding => Icons.code_rounded,
  };
  String get title => switch (this) {
    chat => "Let's think it through.",
    cowork => 'What shall we get done?',
    coding => "Let's build something useful.",
  };
  String get description => switch (this) {
    chat => 'Ask a question, explore an idea, or make sense of your sources.',
    cowork => 'Bring a goal and your files. Asael will coordinate the work and return the results.',
    coding => 'Choose a project, describe the change, and review the files and checks as Asael works.',
  };
  String get placeholder => switch (this) {
    chat => 'What would you like to understand?',
    cowork => 'Describe the outcome you need…',
    coding => 'What should we build, fix, or review?',
  };
  String get compactPlaceholder => switch (this) {
    chat => 'Ask a question…',
    cowork => 'What needs doing?',
    coding => 'Build, fix, or review…',
  };
  List<String> get prompts => switch (this) {
    chat => [
      'Explain this document in plain language',
      'Compare the options and their trade-offs',
      'Help me think through an idea',
    ],
    cowork => [
      'Create an editable PowerPoint presentation',
      'Turn these notes into a client brief',
      'Research this topic and prepare a cited report',
    ],
    coding => [
      "Explain this project's architecture",
      'Find and fix a bug, then run the relevant checks',
      'Build a working prototype for this project',
    ],
  };
}

class AssistantModePicker extends StatelessWidget {
  const AssistantModePicker({
    super.key,
    required this.value,
    required this.onChanged,
  });
  final String value;
  final ValueChanged<String>? onChanged;

  @override
  Widget build(BuildContext context) {
    final selected = AssistantMode.fromWire(value);
    return LayoutBuilder(
      builder: (context, constraints) {
        final vertical =
            constraints.maxWidth < 320 &&
            MediaQuery.textScalerOf(context).scale(14) > 20;
        return Semantics(
          label: 'Assistant mode',
          child: SegmentedButton<AssistantMode>(
            direction: vertical ? Axis.vertical : Axis.horizontal,
            segments: [
              for (final mode in AssistantMode.values)
                ButtonSegment(
                  value: mode,
                  label: Text(mode.label),
                  icon: Icon(mode.icon, size: 17),
                ),
            ],
            selected: {selected},
            showSelectedIcon: false,
            style: ButtonStyle(
              minimumSize: WidgetStatePropertyAll(
                Size(0, usesMacosPresentation() ? 36 : 48),
              ),
              visualDensity: usesMacosPresentation()
                  ? VisualDensity.compact
                  : VisualDensity.standard,
              side: const WidgetStatePropertyAll(BorderSide.none),
              shape: WidgetStatePropertyAll(
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
              ),
              backgroundColor: WidgetStateProperty.resolveWith((states) {
                final colors = Theme.of(context).colorScheme;
                return states.contains(WidgetState.selected) ||
                        states.contains(WidgetState.hovered)
                    ? colors.surfaceContainerHigh
                    : Colors.transparent;
              }),
              foregroundColor: WidgetStateProperty.resolveWith((states) {
                final colors = Theme.of(context).colorScheme;
                return states.contains(WidgetState.selected)
                    ? colors.onSurface
                    : colors.onSurfaceVariant;
              }),
              textStyle: WidgetStateProperty.resolveWith(
                (states) => Theme.of(context).textTheme.labelLarge?.copyWith(
                  fontWeight: states.contains(WidgetState.selected)
                      ? FontWeight.w500
                      : FontWeight.w400,
                ),
              ),
            ),
            onSelectionChanged: onChanged == null
                ? null
                : (value) => onChanged!(value.first.name),
          ),
        );
      },
    );
  }
}
