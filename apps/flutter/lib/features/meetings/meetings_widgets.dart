import 'package:flutter/material.dart';

String meetingLabel(String value) => value
    .split('_')
    .map(
      (part) =>
          part.isEmpty ? part : '${part[0].toUpperCase()}${part.substring(1)}',
    )
    .join(' ');
String meetingTimestamp(DateTime date) => date.toUtc().toIso8601String();
String meetingDuration(num? milliseconds) => milliseconds == null
    ? 'Unavailable'
    : '${(milliseconds / 1000).toStringAsFixed(1)} seconds';

class MeetingSection extends StatelessWidget {
  const MeetingSection(
    this.title, {
    super.key,
    required this.child,
    this.subtitle,
  });
  final String title;
  final String? subtitle;
  final Widget child;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          header: true,
          child: Text(title, style: Theme.of(context).textTheme.titleLarge),
        ),
        if (subtitle != null) ...[
          const SizedBox(height: 6),
          Text(subtitle!, style: Theme.of(context).textTheme.bodySmall),
        ],
        const SizedBox(height: 12),
        child,
        const SizedBox(height: 16),
        const Divider(height: 1),
      ],
    ),
  );
}

class MeetingNotice extends StatelessWidget {
  const MeetingNotice(
    this.message, {
    super.key,
    this.action,
    this.onAction,
    this.error = false,
  });
  final String message;
  final String? action;
  final VoidCallback? onAction;
  final bool error;
  @override
  Widget build(BuildContext context) => Semantics(
    liveRegion: true,
    child: Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            message,
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: error ? Theme.of(context).colorScheme.error : null,
            ),
          ),
          if (action != null)
            TextButton(onPressed: onAction, child: Text(action!)),
        ],
      ),
    ),
  );
}

class MeetingValue extends StatelessWidget {
  const MeetingValue(this.label, this.value, {super.key});
  final String label;
  final String? value;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: Theme.of(context).textTheme.labelMedium),
        const SizedBox(height: 3),
        SelectableText(
          value ?? 'Unavailable',
          style: Theme.of(context).textTheme.bodyMedium,
        ),
      ],
    ),
  );
}

class MeetingDisclosure extends StatelessWidget {
  const MeetingDisclosure(
    this.title, {
    super.key,
    required this.children,
    this.subtitle,
    this.expanded = false,
  });
  final String title;
  final String? subtitle;
  final List<Widget> children;
  final bool expanded;
  @override
  Widget build(BuildContext context) => Material(
    color: Colors.transparent,
    child: ExpansionTile(
      maintainState: true,
      initiallyExpanded: expanded,
      tilePadding: EdgeInsets.zero,
      childrenPadding: const EdgeInsets.only(bottom: 16),
      title: Text(title, style: Theme.of(context).textTheme.titleMedium),
      subtitle: subtitle == null ? null : Text(subtitle!),
      children: [
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: children,
        ),
      ],
    ),
  );
}

class MeetingTextPages extends StatefulWidget {
  const MeetingTextPages({super.key, required this.text, this.pageSize = 8000});
  final String text;
  final int pageSize;
  @override
  State<MeetingTextPages> createState() => _MeetingTextPagesState();
}

class _MeetingTextPagesState extends State<MeetingTextPages> {
  int page = 0;
  @override
  void didUpdateWidget(covariant MeetingTextPages oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.text != widget.text) {
      page = 0;
    }
  }

  @override
  Widget build(BuildContext context) {
    final characters = widget.text.characters;
    final length = characters.length,
        pages = (length / widget.pageSize).ceil().clamp(1, 1000);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SelectableText(
          characters
              .skip(page * widget.pageSize)
              .take(widget.pageSize)
              .toString(),
          style: Theme.of(context).textTheme.bodyLarge,
        ),
        if (pages > 1)
          Wrap(
            spacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text('Transcript page ${page + 1} of $pages'),
              TextButton(
                onPressed: page == 0 ? null : () => setState(() => page--),
                child: const Text('Previous transcript page'),
              ),
              TextButton(
                onPressed: page + 1 >= pages
                    ? null
                    : () => setState(() => page++),
                child: const Text('Next transcript page'),
              ),
            ],
          ),
      ],
    );
  }
}
