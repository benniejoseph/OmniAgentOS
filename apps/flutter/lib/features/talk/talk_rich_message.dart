import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

/// A bounded, presentation-only Markdown subset for assistant responses.
///
/// The server response remains plain text. This widget never executes embedded
/// HTML, scripts, commands, or custom URI schemes. It recognizes the common
/// structural elements produced by Asael and opens only HTTP(S) links through
/// the operating system.
class TalkRichMessage extends StatefulWidget {
  const TalkRichMessage({super.key, required this.text, this.failed = false});

  final String text;
  final bool failed;

  @override
  State<TalkRichMessage> createState() => _TalkRichMessageState();
}

class _TalkRichMessageState extends State<TalkRichMessage> {
  late List<_RichBlock> blocks = _parseBlocks(widget.text);

  @override
  void didUpdateWidget(covariant TalkRichMessage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.text != widget.text) blocks = _parseBlocks(widget.text);
  }

  @override
  Widget build(BuildContext context) {
    if (blocks.isEmpty) return const SizedBox.shrink();
    return SelectionArea(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var index = 0; index < blocks.length; index += 1)
            Padding(
              padding: EdgeInsets.only(
                bottom: index == blocks.length - 1 ? 0 : 12,
              ),
              child: _RichBlockView(
                block: blocks[index],
                failed: widget.failed,
              ),
            ),
        ],
      ),
    );
  }
}

sealed class _RichBlock {
  const _RichBlock();
}

class _ParagraphBlock extends _RichBlock {
  const _ParagraphBlock(this.text);
  final String text;
}

class _HeadingBlock extends _RichBlock {
  const _HeadingBlock(this.level, this.text);
  final int level;
  final String text;
}

class _ListBlock extends _RichBlock {
  const _ListBlock({required this.items, required this.ordered});
  final List<String> items;
  final bool ordered;
}

class _QuoteBlock extends _RichBlock {
  const _QuoteBlock(this.text);
  final String text;
}

class _CodeBlock extends _RichBlock {
  const _CodeBlock({required this.language, required this.code});
  final String language;
  final String code;
}

class _RuleBlock extends _RichBlock {
  const _RuleBlock();
}

class _TableBlock extends _RichBlock {
  const _TableBlock({required this.headers, required this.rows});
  final List<String> headers;
  final List<List<String>> rows;
}

List<_RichBlock> _parseBlocks(String input) {
  final normalized = input
      .replaceAll('\r\n', '\n')
      .replaceAll('\r', '\n')
      .trim();
  if (normalized.isEmpty) return const [];
  final lines = normalized.split('\n');
  final blocks = <_RichBlock>[];
  var index = 0;

  while (index < lines.length) {
    final line = lines[index];
    if (line.trim().isEmpty) {
      index += 1;
      continue;
    }

    final trimmed = line.trimLeft();
    if (trimmed.startsWith('```')) {
      final language = trimmed.substring(3).trim();
      final code = <String>[];
      index += 1;
      while (index < lines.length &&
          !lines[index].trimLeft().startsWith('```')) {
        code.add(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.add(_CodeBlock(language: language, code: code.join('\n')));
      continue;
    }

    final heading = RegExp(r'^(#{1,3})\s+(.+)$').firstMatch(line.trim());
    if (heading != null) {
      blocks.add(
        _HeadingBlock(heading.group(1)!.length, heading.group(2)!.trim()),
      );
      index += 1;
      continue;
    }

    if (_isTableStart(lines, index)) {
      final headers = _tableCells(lines[index]);
      final rows = <List<String>>[];
      index += 2;
      while (index < lines.length && _looksLikeTableRow(lines[index])) {
        final cells = _tableCells(lines[index]);
        rows.add([
          for (var cell = 0; cell < headers.length; cell += 1)
            cell < cells.length ? cells[cell] : '',
        ]);
        index += 1;
      }
      blocks.add(_TableBlock(headers: headers, rows: rows));
      continue;
    }

    if (RegExp(r'^\s*[-*+]\s+').hasMatch(line)) {
      final items = <String>[];
      while (index < lines.length &&
          RegExp(r'^\s*[-*+]\s+').hasMatch(lines[index])) {
        items.add(
          lines[index].replaceFirst(RegExp(r'^\s*[-*+]\s+'), '').trim(),
        );
        index += 1;
      }
      blocks.add(_ListBlock(items: items, ordered: false));
      continue;
    }

    if (RegExp(r'^\s*\d+[.)]\s+').hasMatch(line)) {
      final items = <String>[];
      while (index < lines.length &&
          RegExp(r'^\s*\d+[.)]\s+').hasMatch(lines[index])) {
        items.add(
          lines[index].replaceFirst(RegExp(r'^\s*\d+[.)]\s+'), '').trim(),
        );
        index += 1;
      }
      blocks.add(_ListBlock(items: items, ordered: true));
      continue;
    }

    if (line.trim().startsWith('>')) {
      final quote = <String>[];
      while (index < lines.length && lines[index].trim().startsWith('>')) {
        quote.add(
          lines[index].trim().replaceFirst(RegExp(r'^>\s?'), '').trim(),
        );
        index += 1;
      }
      blocks.add(_QuoteBlock(quote.join(' ')));
      continue;
    }

    if (RegExp(r'^\s*(---+|___+|\*\*\*+)\s*$').hasMatch(line)) {
      blocks.add(const _RuleBlock());
      index += 1;
      continue;
    }

    final paragraph = <String>[line.trim()];
    index += 1;
    while (index < lines.length &&
        lines[index].trim().isNotEmpty &&
        !_startsBlock(lines, index)) {
      paragraph.add(lines[index].trim());
      index += 1;
    }
    blocks.add(_ParagraphBlock(paragraph.join(' ')));
  }

  return List.unmodifiable(blocks);
}

bool _startsBlock(List<String> lines, int index) {
  final line = lines[index];
  final trimmed = line.trimLeft();
  return trimmed.startsWith('```') ||
      RegExp(r'^(#{1,3})\s+').hasMatch(line.trim()) ||
      RegExp(r'^\s*[-*+]\s+').hasMatch(line) ||
      RegExp(r'^\s*\d+[.)]\s+').hasMatch(line) ||
      line.trim().startsWith('>') ||
      RegExp(r'^\s*(---+|___+|\*\*\*+)\s*$').hasMatch(line) ||
      _isTableStart(lines, index);
}

bool _isTableStart(List<String> lines, int index) =>
    index + 1 < lines.length &&
    _looksLikeTableRow(lines[index]) &&
    RegExp(r'^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$')
        .hasMatch(lines[index + 1]);

bool _looksLikeTableRow(String value) {
  final trimmed = value.trim();
  return trimmed.contains('|') && !trimmed.startsWith('```');
}

List<String> _tableCells(String value) {
  var trimmed = value.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.substring(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.substring(0, trimmed.length - 1);
  return trimmed.split('|').map((cell) => cell.trim()).toList(growable: false);
}

class _RichBlockView extends StatelessWidget {
  const _RichBlockView({required this.block, required this.failed});

  final _RichBlock block;
  final bool failed;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final body = theme.textTheme.bodyMedium?.copyWith(
      height: 1.52,
      color: failed ? scheme.error : scheme.onSurface,
    );

    return switch (block) {
      _ParagraphBlock(:final text) => _RichInlineText(text: text, style: body),
      _HeadingBlock(:final level, :final text) => _RichInlineText(
        text: text,
        style: switch (level) {
          1 => theme.textTheme.titleLarge?.copyWith(
            fontWeight: FontWeight.w700,
            height: 1.25,
          ),
          2 => theme.textTheme.titleMedium?.copyWith(
            fontWeight: FontWeight.w700,
            height: 1.3,
          ),
          _ => theme.textTheme.titleSmall?.copyWith(
            fontWeight: FontWeight.w700,
            height: 1.35,
          ),
        },
      ),
      _ListBlock(:final items, :final ordered) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var index = 0; index < items.length; index += 1)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: _RichListItem(
                marker: ordered ? '${index + 1}.' : '•',
                text: items[index],
                style: body,
              ),
            ),
        ],
      ),
      _QuoteBlock(:final text) => Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: scheme.surfaceContainerLow,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: scheme.outlineVariant),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.format_quote_rounded, size: 18, color: scheme.primary),
            const SizedBox(width: 9),
            Expanded(
              child: _RichInlineText(
                text: text,
                style: body?.copyWith(
                  color: scheme.onSurfaceVariant,
                  fontStyle: FontStyle.italic,
                ),
              ),
            ),
          ],
        ),
      ),
      _CodeBlock(:final language, :final code) => _RichCodeBlock(
        language: language,
        code: code,
      ),
      _RuleBlock() => Divider(height: 1, color: scheme.outlineVariant),
      _TableBlock(:final headers, :final rows) => _RichTable(
        headers: headers,
        rows: rows,
      ),
    };
  }
}

class _RichListItem extends StatelessWidget {
  const _RichListItem({
    required this.marker,
    required this.text,
    required this.style,
  });

  final String marker;
  final String text;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    final task = RegExp(r'^\[([ xX])\]\s+(.+)$').firstMatch(text);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 24,
          child: task == null
              ? Text(marker, style: style, textAlign: TextAlign.right)
              : Icon(
                  task.group(1)!.trim().isEmpty
                      ? Icons.check_box_outline_blank_rounded
                      : Icons.check_box_rounded,
                  size: 17,
                  color: task.group(1)!.trim().isEmpty
                      ? Theme.of(context).colorScheme.onSurfaceVariant
                      : Theme.of(context).colorScheme.primary,
                ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: _RichInlineText(text: task?.group(2) ?? text, style: style),
        ),
      ],
    );
  }
}

class _RichInlineText extends StatelessWidget {
  const _RichInlineText({required this.text, required this.style});

  final String text;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) => Text.rich(
    TextSpan(style: style, children: _inlineSpans(context, text, style)),
    textAlign: TextAlign.start,
  );
}

List<InlineSpan> _inlineSpans(
  BuildContext context,
  String value,
  TextStyle? baseStyle,
) {
  final pattern = RegExp(
    r'(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\[[^\]\n]+\]\(https?://[^\s)]+\)|https?://[^\s<]+|\*[^*\n]+\*|_[^_\n]+_)',
  );
  final spans = <InlineSpan>[];
  var cursor = 0;
  for (final match in pattern.allMatches(value)) {
    if (match.start > cursor) {
      spans.add(TextSpan(text: value.substring(cursor, match.start)));
    }
    final token = match.group(0)!;
    if ((token.startsWith('**') && token.endsWith('**')) ||
        (token.startsWith('__') && token.endsWith('__'))) {
      spans.add(
        TextSpan(
          text: token.substring(2, token.length - 2),
          style: const TextStyle(fontWeight: FontWeight.w700),
        ),
      );
    } else if (token.startsWith('`') && token.endsWith('`')) {
      spans.add(
        WidgetSpan(
          alignment: PlaceholderAlignment.middle,
          child: Container(
            margin: const EdgeInsets.symmetric(horizontal: 1),
            padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
            decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.surfaceContainerHigh,
              borderRadius: BorderRadius.circular(5),
            ),
            child: Text(
              token.substring(1, token.length - 1),
              style: baseStyle?.copyWith(
                fontFamily: 'monospace',
                fontSize: (baseStyle?.fontSize ?? 14) * .9,
              ),
            ),
          ),
        ),
      );
    } else if (token.startsWith('[')) {
      final link = RegExp(r'^\[([^\]]+)\]\((https?://[^\s)]+)\)$')
          .firstMatch(token);
      if (link == null) {
        spans.add(TextSpan(text: token));
      } else {
        spans.add(
          _linkSpan(
            context,
            label: link.group(1)!,
            rawUri: link.group(2)!,
            style: baseStyle,
          ),
        );
      }
    } else if (token.startsWith('http://') || token.startsWith('https://')) {
      final punctuation =
          RegExp(r'[.,;:!?]+$').firstMatch(token)?.group(0) ?? '';
      final rawUri = punctuation.isEmpty
          ? token
          : token.substring(0, token.length - punctuation.length);
      spans.add(
        _linkSpan(context, label: rawUri, rawUri: rawUri, style: baseStyle),
      );
      if (punctuation.isNotEmpty) spans.add(TextSpan(text: punctuation));
    } else {
      spans.add(
        TextSpan(
          text: token.substring(1, token.length - 1),
          style: const TextStyle(fontStyle: FontStyle.italic),
        ),
      );
    }
    cursor = match.end;
  }
  if (cursor < value.length) spans.add(TextSpan(text: value.substring(cursor)));
  return spans;
}

InlineSpan _linkSpan(
  BuildContext context, {
  required String label,
  required String rawUri,
  required TextStyle? style,
}) {
  final uri = Uri.tryParse(rawUri);
  if (uri == null || (uri.scheme != 'https' && uri.scheme != 'http')) {
    return TextSpan(text: label);
  }
  final color = Theme.of(context).colorScheme.primary;
  return WidgetSpan(
    alignment: PlaceholderAlignment.baseline,
    baseline: TextBaseline.alphabetic,
    child: Semantics(
      link: true,
      label: label,
      child: InkWell(
        borderRadius: BorderRadius.circular(4),
        onTap: () => launchUrl(uri, mode: LaunchMode.externalApplication),
        child: Text(
          label,
          style: style?.copyWith(
            color: color,
            decoration: TextDecoration.underline,
            decorationColor: color.withValues(alpha: .55),
          ),
        ),
      ),
    ),
  );
}

class _RichCodeBlock extends StatelessWidget {
  const _RichCodeBlock({required this.language, required this.code});

  final String language;
  final String code;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            padding: const EdgeInsets.fromLTRB(12, 5, 4, 5),
            decoration: BoxDecoration(
              color: scheme.surfaceContainerHigh,
              border: Border(bottom: BorderSide(color: scheme.outlineVariant)),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    language.isEmpty ? 'Code' : language,
                    style: Theme.of(context).textTheme.labelSmall
                        ?.copyWith(color: scheme.onSurfaceVariant),
                  ),
                ),
                IconButton(
                  tooltip: 'Copy code',
                  visualDensity: VisualDensity.compact,
                  onPressed: () async {
                    await Clipboard.setData(ClipboardData(text: code));
                    if (!context.mounted) return;
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Code copied')),
                    );
                  },
                  icon: const Icon(Icons.copy_rounded, size: 16),
                ),
              ],
            ),
          ),
          Scrollbar(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.all(13),
              child: Text(
                code,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  fontFamily: 'monospace',
                  height: 1.5,
                  color: scheme.onSurface,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _RichTable extends StatelessWidget {
  const _RichTable({required this.headers, required this.rows});

  final List<String> headers;
  final List<List<String>> rows;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Table(
          defaultColumnWidth: const IntrinsicColumnWidth(),
          border: TableBorder(
            horizontalInside: BorderSide(color: scheme.outlineVariant),
            verticalInside: BorderSide(color: scheme.outlineVariant),
          ),
          defaultVerticalAlignment: TableCellVerticalAlignment.middle,
          children: [
            TableRow(
              decoration: BoxDecoration(color: scheme.surfaceContainerHigh),
              children: [
                for (final header in headers)
                  _TableCell(text: header, header: true),
              ],
            ),
            for (final row in rows)
              TableRow(
                children: [for (final cell in row) _TableCell(text: cell)],
              ),
          ],
        ),
      ),
    );
  }
}

class _TableCell extends StatelessWidget {
  const _TableCell({required this.text, this.header = false});

  final String text;
  final bool header;

  @override
  Widget build(BuildContext context) => Container(
    constraints: const BoxConstraints(minWidth: 96, maxWidth: 280),
    padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
    child: _RichInlineText(
      text: text,
      style: Theme.of(context).textTheme.bodySmall?.copyWith(
        height: 1.4,
        fontWeight: header ? FontWeight.w700 : FontWeight.w400,
      ),
    ),
  );
}
