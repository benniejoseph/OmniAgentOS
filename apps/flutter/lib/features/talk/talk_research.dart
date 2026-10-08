import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import 'talk_rich_message.dart';

Map<String, dynamic> _record(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : <String, dynamic>{};
String _text(Object? value, [int limit = 2000]) {
  if (value is! String) return '';
  final clean = value.replaceAll(
    RegExp(r'[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]'),
    '',
  );
  return clean.substring(0, clean.length.clamp(0, limit)).trim();
}

List<String> _strings(Object? value, {int count = 32, int length = 2000}) =>
    value is List
    ? value
          .take(count)
          .map((item) => _text(item, length))
          .where((item) => item.isNotEmpty)
          .toList(growable: false)
    : const [];

class TalkResearchOptions {
  const TalkResearchOptions({
    this.depth = 'quick',
    this.questions = const [],
    this.sourceGuidance = '',
    this.allowedDomains = const [],
  });
  final String depth;
  final List<String> questions;
  final String sourceGuidance;
  final List<String> allowedDomains;
  Map<String, dynamic> toRequestJson() => {
    'depth': depth,
    'questions': questions,
    'sourceGuidance': sourceGuidance,
    'allowedDomains': allowedDomains,
  };
  TalkResearchOptions withDepth(String value) => TalkResearchOptions(
    depth: value,
    questions: questions,
    sourceGuidance: sourceGuidance,
    allowedDomains: allowedDomains,
  );
  String? get validationError {
    if (!const {'quick', 'deep'}.contains(depth))
      return 'Choose Quick or Deep research.';
    final limit = depth == 'deep' ? 6 : 3;
    if (questions.length > limit)
      return 'Use up to $limit questions for ${depth == 'deep' ? 'Deep' : 'Quick'} research.';
    if (questions.any(
      (question) => question.trim().isEmpty || question.length > 500,
    ))
      return 'Each question needs between 1 and 500 characters.';
    if (sourceGuidance.length > 1500)
      return 'Keep source preferences within 1,500 characters.';
    final domain = RegExp(
      r'^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$',
    );
    if (allowedDomains.length > 10 ||
        allowedDomains.any(
          (value) => value.length > 253 || !domain.hasMatch(value),
        )) {
      return 'Use up to 10 website domains, such as salesforce.com, without a path.';
    }
    return null;
  }
}

class TalkResearchProgress {
  const TalkResearchProgress({
    required this.depth,
    required this.stage,
    required this.questions,
    required this.searches,
    required this.sourcesRead,
    required this.gaps,
    required this.limitations,
  });
  final String depth, stage;
  final List<String> questions, gaps, limitations;
  final int searches, sourcesRead;
  String get label => switch (stage) {
    'planning' => 'Planning the investigation',
    'searching' => 'Finding useful sources',
    'reading' => 'Reading and comparing sources',
    'reviewing' => 'Checking claims against sources',
    'writing' => 'Writing your report',
    'complete' => 'Research finished',
    _ => 'Research in progress',
  };
  static TalkResearchProgress? fromJson(Object? value) {
    final data = _record(value);
    if (data['schemaVersion'] != 1 ||
        !const {'quick', 'deep'}.contains(data['depth']) ||
        !const {
          'planning',
          'searching',
          'reading',
          'reviewing',
          'writing',
          'complete',
        }.contains(data['stage']))
      return null;
    return TalkResearchProgress(
      depth: data['depth'] as String,
      stage: data['stage'] as String,
      questions: _strings(data['questions'], count: 6, length: 500),
      searches: data['searches'] is num
          ? (data['searches'] as num).toInt().clamp(0, 10)
          : 0,
      sourcesRead: data['sourcesRead'] is num
          ? (data['sourcesRead'] as num).toInt().clamp(0, 18)
          : 0,
      gaps: _strings(data['gaps']),
      limitations: _strings(data['limitations']),
    );
  }
}

class TalkResearchSource {
  const TalkResearchSource({
    required this.citationId,
    required this.title,
    required this.uri,
    required this.wasRead,
  });
  final String citationId, title;
  final Uri uri;
  final bool wasRead;
  static TalkResearchSource? fromJson(Object? value) {
    final data = _record(value);
    final uri = Uri.tryParse(_text(data['url'], 4000));
    final citationId = _text(data['citationId'], 128);
    if (uri == null ||
        !const {'http', 'https'}.contains(uri.scheme) ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        citationId.isEmpty)
      return null;
    return TalkResearchSource(
      citationId: citationId,
      title: _text(data['title'], 400),
      uri: uri,
      wasRead: data['evidenceKind'] == 'read_extract',
    );
  }
}

class TalkResearchReport {
  const TalkResearchReport({
    required this.title,
    required this.content,
    required this.partial,
    required this.sources,
    required this.limitations,
    required this.checkedClaims,
  });
  final String title, content;
  final bool partial;
  final List<TalkResearchSource> sources;
  final List<String> limitations;
  final int checkedClaims;
  static TalkResearchReport? fromJson(Object? value) {
    final data = _record(value);
    final content = _text(data['content'], 120000);
    if (data['schemaVersion'] != 1 ||
        content.isEmpty ||
        !const {'ready', 'partial'}.contains(data['status']))
      return null;
    final review = _record(data['claimReview']);
    return TalkResearchReport(
      title: _text(data['title'], 300),
      content: content,
      partial: data['status'] == 'partial',
      sources: data['sources'] is List
          ? (data['sources'] as List)
                .take(100)
                .map(TalkResearchSource.fromJson)
                .whereType<TalkResearchSource>()
                .toList(growable: false)
          : const [],
      limitations: _strings(data['limitations']),
      checkedClaims: review['checkedClaimCount'] is num
          ? (review['checkedClaimCount'] as num).toInt().clamp(0, 64)
          : 0,
    );
  }

  String get linkedContent {
    var linked = content;
    for (var i = 0; i < sources.length; i += 1) {
      linked = linked.replaceAll(
        '[${sources[i].citationId}]',
        '[Source ${i + 1}](${sources[i].uri})',
      );
    }
    return linked.replaceAll(
      RegExp(r'\[web:[^\]\s]+\]'),
      '[Source unavailable]',
    );
  }

  String get markdown =>
      '# ${title.isEmpty ? 'Research report' : title}\n\n$linkedContent\n\n## Sources\n\n${[for (var i = 0; i < sources.length; i += 1) '${i + 1}. [${sources[i].title.isEmpty ? sources[i].uri.host : sources[i].title}](${sources[i].uri}) — ${sources[i].wasRead ? 'Read excerpts' : 'Found in search; not read'}'].join('\n')}';
}

class TalkResearchWorkflow {
  const TalkResearchWorkflow({
    required this.threadId,
    required this.status,
    this.progress,
    this.report,
    this.createdAt,
    this.completedAt,
    this.draft = '',
  });
  final String threadId, status, draft;
  final TalkResearchProgress? progress;
  final TalkResearchReport? report;
  final DateTime? createdAt, completedAt;
  bool get terminal =>
      const {'completed', 'failed', 'canceled'}.contains(status);
  static TalkResearchWorkflow? fromDetail(Map<String, dynamic> payload) {
    final run = _record(payload['run']);
    final input = _record(run['input']);
    final metadata = _record(input['metadata']);
    final options = _record(metadata['researchOptionsV1']);
    if (input['mode'] != 'research' || options['depth'] != 'deep') return null;
    final result = _record(run['result']);
    final steps = payload['steps'] is List
        ? (payload['steps'] as List).map(_record).toList()
        : <Map<String, dynamic>>[];
    steps.sort(
      (a, b) => _text(b['updatedAt'], 80).compareTo(_text(a['updatedAt'], 80)),
    );
    TalkResearchProgress? progress = TalkResearchProgress.fromJson(
      result['researchProgress'],
    );
    var draft = '';
    for (final step in steps) {
      final output = _record(step['output']);
      progress ??= TalkResearchProgress.fromJson(output['researchProgress']);
      if (draft.isEmpty) draft = _text(output['response'], 120000);
    }
    return TalkResearchWorkflow(
      threadId: _text(metadata['threadId'], 200),
      status: _text(run['status'], 40),
      progress: progress,
      report: TalkResearchReport.fromJson(result['researchReportV1']),
      createdAt: DateTime.tryParse(_text(run['createdAt'], 80)),
      completedAt: DateTime.tryParse(_text(run['completedAt'], 80)),
      draft: draft,
    );
  }
}

class TalkResearchOptionsBar extends StatelessWidget {
  const TalkResearchOptionsBar({
    super.key,
    required this.enabled,
    required this.options,
    required this.onToggle,
    required this.onChanged,
  });
  final bool enabled;
  final TalkResearchOptions options;
  final ValueChanged<bool> onToggle;
  final ValueChanged<TalkResearchOptions> onChanged;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Align(
      alignment: Alignment.centerLeft,
      child: Wrap(
        spacing: 8,
        runSpacing: 8,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          FilterChip(
            avatar: const Icon(Icons.travel_explore_rounded, size: 17),
            label: const Text('Research'),
            selected: enabled,
            onSelected: onToggle,
          ),
          if (enabled) ...[
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'quick', label: Text('Quick')),
                ButtonSegment(value: 'deep', label: Text('Deep')),
              ],
              selected: {options.depth},
              showSelectedIcon: false,
              onSelectionChanged: (value) =>
                  onChanged(options.withDepth(value.first)),
            ),
            IconButton(
              tooltip: 'Research questions and sources',
              icon: const Icon(Icons.tune_rounded),
              onPressed: () async {
                final next = await showDialog<TalkResearchOptions>(
                  context: context,
                  builder: (_) => _ResearchOptionsDialog(options: options),
                );
                if (next != null) onChanged(next);
              },
            ),
            Text(
              options.depth == 'deep'
                  ? 'Detailed report · continues in the background'
                  : 'Focused report · a smaller search budget',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ],
      ),
    ),
  );
}

class _ResearchOptionsDialog extends StatefulWidget {
  const _ResearchOptionsDialog({required this.options});
  final TalkResearchOptions options;
  @override
  State<_ResearchOptionsDialog> createState() => _ResearchOptionsDialogState();
}

class _ResearchOptionsDialogState extends State<_ResearchOptionsDialog> {
  late final questions = TextEditingController(
    text: widget.options.questions.join('\n'),
  );
  late final guidance = TextEditingController(
    text: widget.options.sourceGuidance,
  );
  late final domains = TextEditingController(
    text: widget.options.allowedDomains.join('\n'),
  );
  String? error;
  @override
  void dispose() {
    questions.dispose();
    guidance.dispose();
    domains.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Shape your research'),
    content: SizedBox(
      width: 520,
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Leave these blank and Asael will build a plan from your message.',
              style: Theme.of(context).textTheme.bodyMedium,
            ),
            const SizedBox(height: 16),
            TextField(
              controller: questions,
              minLines: 3,
              maxLines: 6,
              maxLength: widget.options.depth == 'deep' ? 3005 : 1502,
              decoration: InputDecoration(
                labelText: 'Questions to answer',
                helperText:
                    'One per line · up to ${widget.options.depth == 'deep' ? 6 : 3} questions',
                alignLabelWithHint: true,
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: guidance,
              minLines: 2,
              maxLines: 4,
              maxLength: 1500,
              decoration: const InputDecoration(
                labelText: 'Preferred sources',
                hintText: 'For example: official docs and recent independent research',
                alignLabelWithHint: true,
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: domains,
              minLines: 2,
              maxLines: 4,
              maxLength: 2540,
              autocorrect: false,
              decoration: const InputDecoration(
                labelText: 'Limit to these websites',
                hintText: 'salesforce.com\nhelp.salesforce.com',
                helperText: 'Optional · up to 10 domains, one per line',
                alignLabelWithHint: true,
              ),
            ),
            if (error != null)
              Text(
                error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      FilledButton(
        onPressed: () {
          final value = TalkResearchOptions(
            depth: widget.options.depth,
            questions: questions.text
                .split('\n')
                .map((line) => line.trim())
                .where((line) => line.isNotEmpty)
                .toList(growable: false),
            sourceGuidance: guidance.text.trim(),
            allowedDomains: domains.text
                .split(RegExp(r'[\s,]+'))
                .map((line) => line.trim().toLowerCase())
                .where((line) => line.isNotEmpty)
                .toSet()
                .toList(growable: false),
          );
          final failure = value.validationError;
          if (failure != null) {
            setState(() => error = failure);
            return;
          }
          Navigator.pop(context, value);
        },
        child: const Text('Save preferences'),
      ),
    ],
  );
}

class TalkResearchPanel extends StatelessWidget {
  const TalkResearchPanel({
    super.key,
    this.progress,
    this.workflow,
    this.refreshing = false,
    this.controlBusy = false,
    this.error,
    this.onRefresh,
    this.onControl,
    this.onNewConversation,
  });
  final TalkResearchProgress? progress;
  final TalkResearchWorkflow? workflow;
  final bool refreshing, controlBusy;
  final String? error;
  final VoidCallback? onRefresh, onNewConversation;
  final ValueChanged<String>? onControl;
  @override
  Widget build(BuildContext context) {
    final current = workflow?.progress ?? progress;
    final report = workflow?.report;
    final state = workflow?.status;
    final created = workflow?.createdAt;
    final elapsed = created == null
        ? null
        : (workflow?.completedAt ?? DateTime.now()).difference(created);
    final label = switch (state) {
      'paused' => 'Research paused',
      'failed' => 'Research stopped early',
      'canceled' => 'Research canceled',
      'completed' =>
        report?.partial == true
            ? 'Report ready · some questions remain'
            : 'Research report ready',
      _ => current?.label ?? 'Preparing your research',
    };
    return Card(
      margin: EdgeInsets.zero,
      child: ExpansionTile(
        initiallyExpanded: true,
        leading: const Icon(Icons.travel_explore_rounded),
        title: Text(label),
        subtitle: Text(
          '${current?.searches ?? 0} searches · ${current?.sourcesRead ?? 0} sources read${elapsed == null ? '' : ' · ${elapsed.inMinutes < 1 ? '${elapsed.inSeconds.clamp(0, 59)}s' : '${elapsed.inMinutes}m'} elapsed'}',
        ),
        childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
        children: [
          if (current != null && current.questions.isNotEmpty)
            Align(
              alignment: Alignment.centerLeft,
              child: Text(
                current.questions.join('\n'),
                maxLines: 6,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          if (current?.gaps.isNotEmpty == true)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  'Still investigating: ${current!.gaps.first.replaceFirst('More relevant source evidence is needed for: ', '')}',
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ),
          if (error != null)
            Text(
              error!,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          Wrap(
            spacing: 4,
            runSpacing: 4,
            children: [
              if (report != null)
                FilledButton.tonalIcon(
                  onPressed: () => _openReport(context, report),
                  icon: const Icon(Icons.article_outlined, size: 18),
                  label: const Text('Read report'),
                ),
              if (report != null)
                TextButton.icon(
                  onPressed: () => _copyReport(context, report.markdown),
                  icon: const Icon(Icons.copy_rounded, size: 16),
                  label: const Text('Copy Markdown'),
                ),
              if (report == null &&
                  workflow?.terminal == true &&
                  workflow!.draft.isNotEmpty)
                TextButton(
                  onPressed: () => showDialog<void>(
                    context: context,
                    builder: (context) => AlertDialog(
                      title: const Text('Unfinished draft'),
                      content: SizedBox(
                        width: 700,
                        child: SingleChildScrollView(
                          child: TalkRichMessage(text: workflow!.draft),
                        ),
                      ),
                      actions: [
                        TextButton(
                          onPressed: () => Navigator.pop(context),
                          child: const Text('Close'),
                        ),
                      ],
                    ),
                  ),
                  child: const Text('Read saved draft'),
                ),
              if (onRefresh != null)
                IconButton(
                  onPressed: refreshing ? null : onRefresh,
                  tooltip: 'Refresh research progress',
                  icon: const Icon(Icons.refresh_rounded),
                ),
              if (workflow != null &&
                  !workflow!.terminal &&
                  onControl != null) ...[
                TextButton.icon(
                  onPressed:
                      controlBusy ||
                          !const {'queued', 'running', 'paused'}.contains(state)
                      ? null
                      : () =>
                            onControl!(state == 'paused' ? 'resume' : 'pause'),
                  icon: Icon(
                    state == 'paused'
                        ? Icons.play_arrow_rounded
                        : Icons.pause_rounded,
                  ),
                  label: Text(state == 'paused' ? 'Resume' : 'Pause'),
                ),
                TextButton(
                  onPressed: controlBusy ? null : () => onControl!('cancel'),
                  child: const Text('Cancel research'),
                ),
              ],
              if (workflow != null &&
                  !workflow!.terminal &&
                  onNewConversation != null)
                TextButton(
                  onPressed: onNewConversation,
                  child: const Text('New conversation'),
                ),
            ],
          ),
          if (workflow != null && !workflow!.terminal)
            Align(
              alignment: Alignment.centerLeft,
              child: Text(
                state == 'paused'
                    ? 'Saved progress is retained. Resume when you are ready.'
                    : 'You can leave this conversation. Research keeps running, and you can reopen it from History.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
        ],
      ),
    );
  }

  Future<void> _copyReport(BuildContext context, String text) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (context.mounted)
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Report and source links copied')),
      );
  }

  Future<void> _openReport(
    BuildContext context,
    TalkResearchReport report,
  ) => showDialog<void>(
    context: context,
    builder: (context) => Dialog.fullscreen(
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Research report'),
          leading: IconButton(
            tooltip: 'Close report',
            icon: const Icon(Icons.close_rounded),
            onPressed: () => Navigator.pop(context),
          ),
          actions: [
            IconButton(
              tooltip: 'Copy report as Markdown',
              icon: const Icon(Icons.copy_rounded),
              onPressed: () => _copyReport(context, report.markdown),
            ),
          ],
        ),
        body: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 820),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    report.title.isEmpty ? 'Research report' : report.title,
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    report.partial
                        ? 'Partial report · review the remaining questions and limitations.'
                        : 'Report ready',
                    style: Theme.of(context).textTheme.bodyMedium,
                  ),
                  const SizedBox(height: 20),
                  TalkRichMessage(text: report.linkedContent),
                  const SizedBox(height: 24),
                  Text(
                    'Sources',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  ...report.sources.asMap().entries.map(
                    (entry) => ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: Text('${entry.key + 1}'),
                      title: Text(
                        entry.value.title.isEmpty
                            ? entry.value.uri.host
                            : entry.value.title,
                      ),
                      subtitle: Text(
                        '${entry.value.uri.host} · ${entry.value.wasRead ? 'Read excerpts' : 'Found in search; not read'}',
                      ),
                      trailing: const Icon(Icons.open_in_new_rounded, size: 18),
                      onTap: () => launchUrl(
                        entry.value.uri,
                        mode: LaunchMode.externalApplication,
                      ),
                    ),
                  ),
                  if (report.limitations.isNotEmpty) ...[
                    const SizedBox(height: 16),
                    Text(
                      'What to keep in mind',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 8),
                    Text(report.limitations.join('\n\n')),
                  ],
                  const SizedBox(height: 16),
                  Text(
                    '${report.checkedClaims} claims matched to exact source quotes. This checks the quoted evidence, not factual truth or every possible claim.',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
