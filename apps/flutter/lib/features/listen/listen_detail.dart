import 'package:dio/dio.dart';
import 'package:flutter/material.dart';

import '../../core/network/native_workspace_access.dart';
import 'listen_bridge.dart';
import 'listen_controller.dart';
import 'listen_repository.dart';
import 'listen_view.dart';

class ListenDetail extends StatefulWidget {
  const ListenDetail({super.key, required this.access, required this.id});
  final NativeWorkspaceAccess access;
  final String id;
  @override
  State<ListenDetail> createState() => _ListenDetailState();
}

class _ListenDetailState extends State<ListenDetail>
    with WidgetsBindingObserver {
  ListenJson? _conversation;
  String? _error;
  bool _loading = true;
  int _generation = 0;
  CancelToken? _cancel;
  bool get _current => mounted && widget.access.current;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _cancel?.cancel('Conversation closed.');
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) {
      _cancel?.cancel('Conversation hidden.');
      _generation++;
      if (mounted) {
        setState(() {
          _conversation = null;
          _loading = true;
        });
      }
    } else {
      _load();
    }
  }

  Future<void> _load() async {
    if (!_current) return;
    final generation = ++_generation;
    _cancel?.cancel('Conversation refreshed.');
    final cancel = _cancel = CancelToken();
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final value = await ListenRepository(widget.access)
          .conversation(widget.id, cancel);
      if (_current && generation == _generation) {
        setState(() => _conversation = value);
      }
    } catch (error) {
      if (_current && generation == _generation) {
        setState(() => _error = listenError(error));
      }
    } finally {
      if (_current && generation == _generation) {
        setState(() => _loading = false);
      }
    }
  }

  void _showSource(ListenJson citation, List<ListenJson> turns) {
    if (!_current) return;
    final matching = turns
        .where((turn) => turn['turnId'] == citation['turnId'])
        .toList();
    if (matching.isEmpty) return;
    final turn = matching.first;
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'From the conversation',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 12),
                Text(
                  '${_speaker(turn)} · ${listenDuration(turn['startMilliseconds'])}–${listenDuration(turn['endMilliseconds'])}',
                ),
                const SizedBox(height: 16),
                SelectableText(listenText(turn['text'])),
                const SizedBox(height: 16),
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('Done'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _cited(
    ListenJson item,
    List<ListenJson> turns, {
    String? heading,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 20),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (heading != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Text(heading, style: Theme.of(context).textTheme.titleSmall),
          ),
        SelectableText(listenText(item['text'])),
        if (listenRows(item['citations']).isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Wrap(
              spacing: 8,
              runSpacing: 4,
              children: [
                for (final citation in listenRows(item['citations']).take(6))
                  TextButton.icon(
                    style: TextButton.styleFrom(
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                    ),
                    onPressed: () => _showSource(citation, turns),
                    icon: const Icon(Icons.format_quote_rounded, size: 16),
                    label: Text(listenDuration(citation['startMilliseconds'])),
                  ),
              ],
            ),
          ),
      ],
    ),
  );

  Widget _section(
    String title,
    List<Widget> children, {
    bool expanded = false,
  }) => ExpansionTile(
    tilePadding: EdgeInsets.zero,
    childrenPadding: const EdgeInsets.only(top: 8),
    initiallyExpanded: expanded,
    title: Text(title, style: Theme.of(context).textTheme.titleMedium),
    children: children,
  );

  @override
  Widget build(BuildContext context) {
    final conversation = _conversation;
    final media = listenMap(conversation?['media']);
    // Capture revisions wrap the typed output; accept direct output for the
    // compact conversation read contract as well.
    final output = media['output'] is Map ? listenMap(media['output']) : media;
    final enrichment = listenMap(output['conversation']);
    final clientContext = listenMap(conversation?['clientContext']);
    final turns = listenRows(output['turns']);
    final actions = listenRows(output['actionItems']);
    final decisions = listenRows(output['decisions']);
    final chapters = listenRows(output['chapters']);
    final categories = enrichment['categories'] is List
        ? enrichment['categories'] as List
        : const [];
    return Scaffold(
      appBar: AppBar(
        title: const Text('Conversation notes'),
        actions: [
          IconButton(
            tooltip: 'Refresh notes',
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: !_current
          ? const Center(
              child: Text('Unlock your workspace to read this conversation.'),
            )
          : ListView(
              padding: const EdgeInsets.fromLTRB(24, 12, 24, 48),
              children: [
                Center(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 820),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        if (_loading) const LinearProgressIndicator(),
                        if (_error != null)
                          Text(
                            _error!,
                            style: TextStyle(
                              color: Theme.of(context).colorScheme.error,
                            ),
                          ),
                        if (conversation != null) ...[
                          Text(
                            listenText(conversation['title'], 'Conversation'),
                            style: Theme.of(context).textTheme.headlineSmall,
                          ),
                          const SizedBox(height: 8),
                          Text(
                            '${listenDate(conversation['recordedAt'] ?? conversation['createdAt'])} · ${listenState(conversation['status'])}',
                          ),
                          const SizedBox(height: 16),
                          if (listenText(clientContext['message']).isNotEmpty)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 16),
                              child: Row(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  const Icon(Icons.business_outlined, size: 18),
                                  const SizedBox(width: 8),
                                  Expanded(
                                    child: Text(
                                      listenText(clientContext['message']),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          if (categories.isNotEmpty)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 16),
                              child: Wrap(
                                spacing: 8,
                                runSpacing: 8,
                                children: [
                                  for (final category
                                      in categories.whereType<String>())
                                    Chip(label: Text(category)),
                                ],
                              ),
                            ),
                          if (output['summary'] is Map)
                            _cited(
                              listenMap(output['summary']),
                              turns,
                              heading: 'What mattered',
                            )
                          else if (listenText(conversation['summary'])
                              .isNotEmpty)
                            SelectableText(listenText(conversation['summary']))
                          else
                            const Text(
                              'Your notes are still being prepared. You can come back later; the recording is saved.',
                            ),
                          if (actions.isNotEmpty)
                            _section('Follow-ups · ${actions.length}', [
                              const Padding(
                                padding: EdgeInsets.only(bottom: 16),
                                child: Text(
                                  'These are suggestions from the conversation. Check who committed to each step before treating it as your task.',
                                ),
                              ),
                              for (final item in actions)
                                _cited(
                                  item,
                                  turns,
                                  heading: _actionHeading(item, turns),
                                ),
                            ], expanded: true),
                          if (decisions.isNotEmpty)
                            _section('Decisions', [
                              for (final item in decisions) _cited(item, turns),
                            ]),
                          if (listenRows(enrichment['keyFacts']).isNotEmpty)
                            _section('Context to remember', [
                              for (final item in listenRows(
                                enrichment['keyFacts'],
                              ))
                                _cited(item, turns),
                            ]),
                          if (listenRows(enrichment['relationships'])
                              .isNotEmpty)
                            _section('People & relationships', [
                              const Padding(
                                padding: EdgeInsets.only(bottom: 16),
                                child: Text(
                                  'What this conversation says about people and their connections. Names and relationships may need your correction.',
                                ),
                              ),
                              for (final item in listenRows(
                                enrichment['relationships'],
                              ))
                                _cited(item, turns),
                            ]),
                          if (listenRows(enrichment['openQuestions'])
                              .isNotEmpty)
                            _section('Still open', [
                              for (final item in listenRows(
                                enrichment['openQuestions'],
                              ))
                                _cited(item, turns),
                            ]),
                          if (chapters.isNotEmpty)
                            _section('Topics · ${chapters.length}', [
                              for (final item in chapters)
                                _cited(
                                  item,
                                  turns,
                                  heading: listenText(item['title']),
                                ),
                            ]),
                          if (turns.isNotEmpty)
                            _section('Transcript', [
                              SizedBox(
                                height: 420,
                                child: ListView.builder(
                                  itemCount: turns.length,
                                  itemBuilder: (_, index) {
                                    final turn = turns[index];
                                    return Padding(
                                      padding: const EdgeInsets.only(
                                        bottom: 20,
                                      ),
                                      child: Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.stretch,
                                        children: [
                                          Text(
                                            '${_speaker(turn)} · ${listenDuration(turn['startMilliseconds'])}',
                                            style: Theme.of(context)
                                                .textTheme
                                                .labelLarge,
                                          ),
                                          const SizedBox(height: 6),
                                          SelectableText(
                                            listenText(turn['text']),
                                          ),
                                        ],
                                      ),
                                    );
                                  },
                                ),
                              ),
                            ])
                          else if (listenText(conversation['transcript'])
                              .isNotEmpty)
                            _section('Transcript', [
                              SelectableText(
                                listenText(conversation['transcript']),
                              ),
                            ]),
                          const SizedBox(height: 24),
                          Text(
                            'Conversation notes are source material for ATLAS. Captured speech does not authorise actions or confirm someone’s identity.',
                            style: Theme.of(context).textTheme.bodySmall
                                ?.copyWith(
                                  color: Theme.of(context)
                                      .colorScheme
                                      .onSurfaceVariant,
                                ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ],
            ),
    );
  }
}

String _speaker(ListenJson turn) {
  final speaker = listenMap(turn['speaker']);
  if (speaker['identity'] == 'known' &&
      listenText(speaker['displayName']).isNotEmpty) {
    return listenText(speaker['displayName']);
  }
  final label = listenText(speaker['label']).split('·').first.trim();
  final number = RegExp(
    r'^(?:speaker[ _-]*)?([a-z]|\d{1,3})$',
    caseSensitive: false,
  ).firstMatch(label)?.group(1);
  final part = listenInt(turn['segmentIndex']) + 1;
  return '${number == null ? 'Unidentified speaker' : 'Speaker $number'} · part $part';
}

String _actionHeading(ListenJson item, List<ListenJson> turns) {
  String owner = 'Owner to confirm';
  if (item['ownershipEvidence'] == 'explicit' &&
      item['ownerParticipantId'] != null) {
    final match = turns
        .where(
          (turn) =>
              listenMap(turn['speaker'])['participantId'] ==
              item['ownerParticipantId'],
        )
        .firstOrNull;
    if (match != null) owner = _speaker(match);
  }
  return item['dueDateEvidence'] == 'explicit' && item['dueAt'] != null
      ? '$owner · Due ${listenDate(item['dueAt'])}'
      : owner;
}
