import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../meetings/meetings.dart';
import '../meetings/meetings_api_repository.dart';
import '../meetings/meetings_providers.dart';
import 'accounts_advanced_contracts.dart';
import 'accounts_contracts.dart';
import 'accounts_controller.dart';
import 'accounts_repository.dart';
import 'accounts_workflow_contracts.dart';

/// Forms use the current published definition and authorized source choices.
/// Only the Account action controller may admit a write.
class AccountWorkflowReview extends ConsumerStatefulWidget {
  const AccountWorkflowReview({super.key, required this.controller});
  final AccountsController controller;
  @override
  ConsumerState<AccountWorkflowReview> createState() =>
      _AccountWorkflowReviewState();
}

class _AccountWorkflowReviewState extends ConsumerState<AccountWorkflowReview> {
  final _texts = <String, TextEditingController>{};
  final _exactRun = TextEditingController();
  AccountJson? _definition, _reviewValues;
  CustomerAccountSummary? _reviewedAccount;
  AccountWorkflowRun? _run;
  AccountJson _values = {};
  List<Meeting> _meetings = const [];
  Meeting? _meeting;
  CancelToken? _read;
  String? _error;
  int _epoch = 0;
  bool _reading = false;
  bool get _current =>
      mounted &&
      widget.controller.readable &&
      widget.controller.actions?.available == true;
  bool get _currentAccount =>
      _current && widget.controller.detail.state == AccountReadState.current;
  bool get _editable =>
      _currentAccount &&
      !_reading &&
      widget.controller.actions?.locked == false;

  @override
  void didUpdateWidget(covariant AccountWorkflowReview oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, widget.controller)) {
      _clear();
    }
  }

  void _clear() {
    _epoch++;
    _read?.cancel('Workflow selection changed.');
    _read = null;
    _definition = _reviewValues = null;
    _reviewedAccount = null;
    _run = null;
    _values = {};
    _meetings = const [];
    _meeting = null;
    _reading = false;
    _error = null;
    _exactRun.clear();
    for (final value in _texts.values) {
      value.dispose();
    }
    _texts.clear();
  }

  @override
  void dispose() {
    _clear();
    _exactRun.dispose();
    super.dispose();
  }

  List<AccountJson> get _pack => accountList(
    widget
            .controller
            .advancedReads[AccountAdvancedKind.workflows]!
            .value
            ?.raw['pack'] ??
        [],
    8,
    accountMap,
  );
  bool get _definitionCurrent =>
      _definition != null &&
      (_run != null
          ? (_run!.definition != null &&
                _run!.definition!['definitionSha256'] ==
                    _definition!['definitionSha256'])
          : widget
                        .controller
                        .advancedReads[AccountAdvancedKind.workflows]!
                        .state ==
                    AccountReadState.current &&
                _pack.any(
                  (row) =>
                      row['definitionSha256'] ==
                      _definition!['definitionSha256'],
                ));

  void _choose(AccountJson definition, {AccountWorkflowRun? run}) {
    setState(() {
      _clear();
      _definition = definition;
      _run = run;
      final draft = widget.controller.actions?.workflowDraft;
      if (draft?['accountId'] == widget.controller.accountId &&
          draft?['definitionSha256'] == definition['definitionSha256'] &&
          draft?['runId'] == run?.run['runId']) {
        _values = Map<String, dynamic>.from(accountMap(draft!['values']));
      } else if (run != null) {
        _values = {
          'status': 'blocked',
          'summary': '',
          'nextAction': '',
          'artifactReceipts': <Object>[],
        };
      }
    });
    if (definition['workflowId'] == 'meeting_prep_follow_up' && run == null) {
      _loadMeetings();
    }
  }

  void _change(String key, Object? value) {
    setState(() {
      _values[key] = value;
      _reviewValues = null;
      _reviewedAccount = null;
      _error = null;
    });
    _persist();
  }

  void _persist() {
    if (_definition == null || widget.controller.accountId == null) {
      return;
    }
    widget.controller.actions?.editWorkflowDraft({
      'accountId': widget.controller.accountId,
      'definitionSha256': _definition!['definitionSha256'],
      'runId': _run?.run['runId'],
      'values': _values,
    });
  }

  Future<void> _openRun(String id) async {
    final controller = widget.controller,
        repo = controller.repository,
        scope = controller.workspaceId,
        account = controller.accountId;
    if (!_current ||
        repo is! AccountsWorkflowRepository ||
        scope == null ||
        account == null ||
        _reading) {
      return;
    }
    final epoch = ++_epoch, token = CancelToken();
    _read?.cancel('New exact workflow read.');
    _read = token;
    setState(() {
      _reading = true;
      _error = null;
      _run = null;
      _definition = _reviewValues = null;
    });
    bool current() =>
        _current && identical(widget.controller, controller) && epoch == _epoch;
    try {
      final result = await (repo as AccountsWorkflowRepository).readWorkflow(
        account,
        id.trim(),
        scope,
        token,
      );
      if (current()) {
        if (result.definition != null) {
          _choose(result.definition!, run: result);
        } else {
          setState(() {
            _run = result;
            _reading = false;
          });
        }
      }
    } catch (error) {
      if (current()) {
        setState(
          () => _error = error is FormatException ? error.message : 'The exact workflow run could not be read. Saved acceptance remains valid.',
        );
      }
    } finally {
      if (current()) {
        setState(() => _reading = false);
      }
    }
  }

  Future<void> _loadMeetings({String? exactId}) async {
    if (!_current) {
      return;
    }
    final controller = widget.controller,
        repo = ref.read(meetingsRepositoryProvider),
        owner = controller.repository.access.owner,
        epoch = _epoch;
    if (repo is! LiveMeetingsRepository || owner == null) {
      setState(() => _error = 'Authorized Meeting choices are unavailable.');
      return;
    }
    final access = repo.access,
        generation = access.generation,
        token = CancelToken();
    bool current() =>
        _current &&
        identical(controller, widget.controller) &&
        epoch == _epoch &&
        identical(ref.read(meetingsRepositoryProvider), repo) &&
        repo.authorityCurrent() &&
        generation == access.generation &&
        access.owner?.tenantId == owner.tenantId &&
        access.owner?.userId == owner.userId &&
        access.owner?.actorId == owner.actorId &&
        access.owner?.role == owner.role &&
        access.owner?.apiScope == owner.apiScope;
    _read?.cancel('Meeting choices changed.');
    _read = token;
    setState(() {
      _reading = true;
      _error = null;
      _meeting = null;
      if (exactId == null) {
        _meetings = const [];
      }
    });
    try {
      accountRequire(current());
      if (exactId == null) {
        final result = await repo.listSnapshot(
          token,
          workspaceId: controller.workspaceId,
        );
        if (current()) {
          setState(() => _meetings = result.meetings);
        }
      } else {
        final result = await repo.detailSnapshot(
          exactId,
          token,
          workspaceId: controller.workspaceId,
        );
        if (current()) {
          setState(() => _meeting = result.meeting);
          _change('meetingId', result.meeting.id);
          _change('participantIds', <String>[]);
        }
      }
    } catch (_) {
      if (_current && epoch == _epoch) {
        setState(
          () => _error = 'Meeting choices could not be confirmed for this Account workspace. Refresh the source before selecting.',
        );
      }
    } finally {
      if (_current && epoch == _epoch) {
        setState(() => _reading = false);
      }
    }
  }

  AccountJson _normalizedInput() {
    final definition = _definition!,
        result = <String, dynamic>{'workflowId': definition['workflowId']};
    for (final field in accountList(
      definition['inputFields'],
      20,
      accountMap,
    )) {
      final id = field['fieldId'] as String,
          type = field['valueType'],
          raw = _values[id];
      if (type == 'id_list') {
        result[id] = raw ?? <String>[];
      } else if (type == 'id') {
        result[id] = raw;
      } else if (type == 'text_list') {
        result[id] = (raw as String? ?? '')
            .split('\n')
            .map((line) => line.trim())
            .where((line) => line.isNotEmpty)
            .toList();
      } else if (type == 'timestamp') {
        final text = raw as String? ?? '';
        result[id] = text.isEmpty ? null : accountDate(text);
      } else if (type == 'money') {
        final text = raw as String? ?? '';
        result[id] = text.isEmpty ? null : int.tryParse(text);
        accountRequire(
          text.isEmpty || result[id] != null,
          'Enter a whole number of minor currency units.',
        );
      } else {
        final text = (raw as String? ?? '').trim();
        result[id] = id == 'currency' && text.isEmpty ? null : text;
      }
      if (type == 'id' || type == 'id_list') {
        final selected = type == 'id_list'
            ? List<String>.from(result[id] as List)
            : <String>[if (result[id] != null) result[id] as String];
        final choices = id == 'meetingId'
            ? <String>[if (_meeting != null) _meeting!.id]
            : id == 'participantIds'
            ? (_meeting?.participants ?? <MeetingParticipant>[])
                  .map((item) => item.id)
                  .toList()
            : _factChoices(id).map((item) => item.id).toList();
        accountRequire(
          selected.every(choices.contains),
          'A saved selection is no longer a current authorized choice. Refresh and select it again.',
        );
      }
    }
    accountWorkflowInput(result);
    return result;
  }

  Future<void> _review() async {
    final controller = widget.controller,
        account = controller.detail.value?.account,
        definition = _definition,
        owner = controller.repository.access.owner,
        scope = controller.workspaceId;
    if (!_editable ||
        !_definitionCurrent ||
        account == null ||
        owner == null ||
        definition == null ||
        scope == null) {
      return;
    }
    final epoch = _epoch;
    try {
      final values = _run == null
          ? _normalizedInput()
          : <String, dynamic>{
              'status': _values['status'],
              'summary': (_values['summary'] as String? ?? '').trim(),
              'nextAction': (_values['nextAction'] as String? ?? '').trim(),
              'artifactReceipts': _values['artifactReceipts'] ?? <Object>[],
            };
      if (_run != null) {
        final receipts = accountList(
              values['artifactReceipts'],
              20,
              accountMap,
            ),
            progress = _run!.progress;
        final artifacts = progress['state'] == 'available'
            ? accountList(progress['artifacts'], 100, accountMap)
            : <AccountJson>[];
        final evidenceKeys = accountList(
          definition['evidenceRequirements'],
          20,
          accountMap,
        ).map((item) => item['evidenceKey']).toSet();
        for (final receipt in receipts) {
          final artifact = artifacts
              .where(
                (item) =>
                    item['id'] == receipt['projectArtifactId'] &&
                    item['status'] == 'verified',
              )
              .firstOrNull;
          accountRequire(
            artifact != null &&
                (receipt['evidenceKeys'] as List).every(
                  evidenceKeys.contains,
                ) &&
                (receipt['evidenceRefs'] as List).every(
                  (reference) =>
                      (artifact['evidenceRefs'] as List).contains(reference),
                ),
            'Refresh the exact project artifacts and select their current verified evidence before recording an outcome.',
          );
        }
        if (values['status'] == 'completed') {
          final requiredArtifacts = accountList(
            definition['artifacts'],
            20,
            accountMap,
          ).where((item) => item['required'] == true);
          final requiredEvidence = accountList(
            definition['evidenceRequirements'],
            20,
            accountMap,
          ).where((item) => item['required'] == true);
          accountRequire(
            requiredArtifacts.every(
                  (item) => receipts.any(
                    (receipt) =>
                        receipt['artifactKey'] == item['artifactKey'] &&
                        (receipt['evidenceRefs'] as List).isNotEmpty,
                  ),
                ) &&
                requiredEvidence.every(
                  (item) => receipts.any(
                    (receipt) =>
                        (receipt['evidenceKeys'] as List).contains(
                          item['evidenceKey'],
                        ) &&
                        (receipt['evidenceRefs'] as List).isNotEmpty,
                  ),
                ),
            'Completion requires the specified verified artifacts and evidence. Record a blocked outcome when that evidence is missing.',
          );
        }
      }
      await AccountWorkflowIntent.prepare(
        owner,
        scope,
        'preview-only',
        account,
        definition,
        values,
        run: _run?.run,
      );
      if (_current &&
          identical(controller, widget.controller) &&
          epoch == _epoch) {
        setState(() {
          _reviewValues = accountFreeze(values);
          _reviewedAccount = account;
          _error = null;
        });
      }
    } catch (error) {
      if (_current && epoch == _epoch) {
        setState(
          () => _error = error is FormatException
              ? error.message
              : 'The workflow input is incomplete. Review the required fields.',
        );
      }
    }
  }

  Future<void> _confirm() async {
    final controller = widget.controller,
        values = _reviewValues,
        account = _reviewedAccount,
        definition = _definition,
        run = _run,
        epoch = _epoch;
    if (values == null || account == null || definition == null) {
      return;
    }
    bool current() =>
        _currentAccount &&
        identical(controller, widget.controller) &&
        epoch == _epoch &&
        identical(values, _reviewValues) &&
        identical(definition, _definition) &&
        _definitionCurrent &&
        controller.detail.value?.account.sha256 == account.sha256 &&
        controller.detail.value?.account.revision == account.revision;
    await controller.actions!.submitWorkflow(
      account,
      definition,
      values,
      reviewedRun: run,
      isReviewCurrent: current,
    );
    if (mounted &&
        identical(controller, widget.controller) &&
        epoch == _epoch) {
      setState(() {
        _reviewValues = null;
        _reviewedAccount = null;
      });
    }
  }

  Widget _text(
    String id,
    String label, {
    String? helper,
    int lines = 1,
    int? maxLength,
  }) {
    final text = _texts.putIfAbsent(
      id,
      () => TextEditingController(text: _values[id] as String? ?? ''),
    );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: TextField(
        controller: text,
        enabled: _editable,
        minLines: lines,
        maxLines: lines == 1 ? 1 : 6,
        maxLength: maxLength,
        decoration: InputDecoration(
          labelText: label,
          helperText: helper,
          helperMaxLines: 5,
        ),
        onChanged: (value) => _change(id, value),
      ),
    );
  }

  List<({String id, String label})> _factChoices(String field) {
    final kinds = field == 'productIds'
        ? {'product'}
        : field == 'caseIds'
        ? {'case'}
        : {'contact', 'stakeholder'};
    final choices = <String, String>{};
    for (final fact
        in widget.controller.detail.value?.facts ?? <CustomerFact>[]) {
      if (kinds.contains(fact.kind) && fact.value['entityId'] is String) {
        choices[fact.value['entityId'] as String] =
            '${fact.summary} · ${fact.freshness}';
      }
    }
    return choices.entries
        .map((entry) => (id: entry.key, label: entry.value))
        .toList();
  }

  Widget _ids(AccountJson field) {
    final id = field['fieldId'] as String;
    if (id == 'meetingId') {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Meeting choices · up to 100 currently authorized records',
          ),
          OutlinedButton(
            onPressed: _editable ? _loadMeetings : null,
            child: const Text('Refresh Meeting choices'),
          ),
          for (final meeting in _meetings)
            CheckboxListTile(
              value: _values[id] == meeting.id,
              title: Text(meeting.title),
              subtitle: Text(meeting.startAt.toLocal().toString()),
              onChanged: _editable
                  ? (value) => _loadMeetings(exactId: meeting.id)
                  : null,
            ),
          if (_meetings.isEmpty && !_reading)
            const Text(
              'No Meeting choices loaded. Refresh or create the Meeting in Meetings first.',
            ),
        ],
      );
    }
    final choices = id == 'participantIds'
        ? (_meeting?.participants ?? <MeetingParticipant>[])
              .map((item) => (id: item.id, label: item.name))
              .toList()
        : _factChoices(id);
    final many = field['valueType'] == 'id_list',
        selected = many
            ? List<String>.from(_values[id] as List? ?? [])
            : <String>[_values[id] as String? ?? ''];
    return ExpansionTile(
      title: Text(
        '${field['label']} · ${selected.where((id) => id.isNotEmpty).length} selected',
      ),
      initiallyExpanded: field['required'] == true,
      children: [
        if (choices.isEmpty)
          const Text(
            'No authorized choices loaded. Read current Account facts, or select a Meeting for its participants.',
          ),
        for (final item in choices)
          CheckboxListTile(
            value: selected.contains(item.id),
            title: Text(item.label),
            subtitle: Text(item.id),
            onChanged: !_editable
                ? null
                : (checked) {
                    if (many) {
                      _change(
                        id,
                        checked == true
                            ? [...selected, item.id]
                            : selected
                                  .where((value) => value != item.id)
                                  .toList(),
                      );
                    } else {
                      _change(id, checked == true ? item.id : null);
                    }
                  },
          ),
        for (final old in selected.where(
          (id) => id.isNotEmpty && !choices.any((choice) => choice.id == id),
        ))
          ListTile(
            title: Text('Saved selection · current choice unavailable: $old'),
            trailing: IconButton(
              tooltip: 'Remove saved selection',
              icon: const Icon(Icons.close),
              onPressed: !_editable
                  ? null
                  : () => _change(
                      id,
                      many
                          ? selected.where((value) => value != old).toList()
                          : null,
                    ),
            ),
          ),
      ],
    );
  }

  Widget _field(AccountJson field) {
    final id = field['fieldId'] as String,
        type = field['valueType'],
        label = '${field['label']}${field['required'] == true ? ' *' : ''}';
    if (type == 'id' || type == 'id_list') {
      return _ids(field);
    }
    final allowed = List<String>.from(field['allowedValues'] as List);
    if (type == 'enum' && allowed.isNotEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: DropdownButtonFormField<String>(
          key: ValueKey((id, _values[id])),
          initialValue: _values[id] as String?,
          isExpanded: true,
          decoration: InputDecoration(labelText: label),
          items: [
            for (final value in allowed)
              DropdownMenuItem(value: value, child: Text(value)),
          ],
          onChanged: _editable ? (value) => _change(id, value) : null,
        ),
      );
    }
    return _text(
      id,
      label,
      lines: type == 'text_list' || id == 'objective' || id == 'customerImpact'
          ? 3
          : 1,
      helper: type == 'text_list'
          ? 'One entry per line. Up to 20 entries.'
          : type == 'timestamp'
          ? 'UTC time, for example 2026-10-05T09:00:00.000Z.'
          : type == 'money'
          ? 'Whole minor currency units, paired with the three-letter currency.'
          : id == 'currency'
          ? 'Three uppercase letters, paired with an amount.'
          : null,
      maxLength: type == 'text_list'
          ? 10019
          : id == 'objective' || id == 'customerImpact'
          ? 2000
          : id == 'requestedOutcome'
          ? 1000
          : type == 'timestamp'
          ? 24
          : 500,
    );
  }

  Widget _outcomeArtifacts() {
    final run = _run!, definition = _definition!, progress = run.progress;
    final available = progress['state'] == 'available';
    final artifacts = available
        ? accountList(
            progress['artifacts'],
            100,
            accountMap,
          ).where((item) => item['status'] == 'verified').toList()
        : <AccountJson>[];
    final receipts = accountList(
      _values['artifactReceipts'] ?? [],
      20,
      accountMap,
    );
    void setReceipt(String key, AccountJson? value) =>
        _change('artifactReceipts', [
          for (final receipt in receipts)
            if (receipt['artifactKey'] != key) receipt,
          ?value,
        ]);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          available
              ? 'Choose verified artifacts from the current project read. ${progress['artifactsMayBeIncomplete'] == true ? 'The bounded artifact list may be incomplete.' : ''}'
              : 'Project artifacts are unavailable. A completed outcome requires verified required artifacts; a blocked or cancelled outcome may describe the gap.',
        ),
        for (final requirement in accountList(
          definition['artifacts'],
          20,
          accountMap,
        ))
          Builder(
            builder: (context) {
              final key = requirement['artifactKey'] as String,
                  selected = receipts
                      .where((row) => row['artifactKey'] == key)
                      .firstOrNull;
              final choice = artifacts
                  .where((row) => row['id'] == selected?['projectArtifactId'])
                  .firstOrNull;
              return Card(
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '${requirement['title']}${requirement['required'] == true ? ' · required for completion' : ''}',
                      ),
                      Text(requirement['description'] as String),
                      DropdownButtonFormField<String>(
                        key: ValueKey((key, selected?['projectArtifactId'])),
                        initialValue: choice?['id'] as String?,
                        isExpanded: true,
                        decoration: const InputDecoration(
                          labelText: 'Verified project artifact',
                        ),
                        items: [
                          for (final item in artifacts)
                            DropdownMenuItem(
                              value: item['id'] as String,
                              child: Text(item['title'] as String),
                            ),
                        ],
                        onChanged: !_editable
                            ? null
                            : (id) => setReceipt(key, {
                                'artifactKey': key,
                                'projectArtifactId': id,
                                'evidenceKeys': <String>[],
                                'evidenceRefs': <String>[],
                              }),
                      ),
                      if (selected != null) ...[
                        TextButton(
                          onPressed: _editable
                              ? () => setReceipt(key, null)
                              : null,
                          child: const Text('Remove artifact receipt'),
                        ),
                        for (final evidence in accountList(
                          definition['evidenceRequirements'],
                          20,
                          accountMap,
                        ))
                          CheckboxListTile(
                            title: Text(
                              '${evidence['title']}${evidence['required'] == true ? ' · required for completion' : ''}',
                            ),
                            value: (selected['evidenceKeys'] as List).contains(
                              evidence['evidenceKey'],
                            ),
                            onChanged: !_editable
                                ? null
                                : (checked) {
                                    final keys = List<String>.from(
                                      selected['evidenceKeys'] as List,
                                    );
                                    setReceipt(key, {
                                      ...selected,
                                      'evidenceKeys': checked == true
                                          ? [...keys, evidence['evidenceKey']]
                                          : keys
                                                .where(
                                                  (value) =>
                                                      value !=
                                                      evidence['evidenceKey'],
                                                )
                                                .toList(),
                                    });
                                  },
                          ),
                        for (final reference
                            in choice?['evidenceRefs'] as List? ?? [])
                          CheckboxListTile(
                            title: Text(reference as String),
                            value: (selected['evidenceRefs'] as List).contains(
                              reference,
                            ),
                            onChanged: !_editable
                                ? null
                                : (checked) {
                                    final refs = List<String>.from(
                                      selected['evidenceRefs'] as List,
                                    );
                                    setReceipt(key, {
                                      ...selected,
                                      'evidenceRefs': checked == true
                                          ? [...refs, reference]
                                          : refs
                                                .where(
                                                  (value) => value != reference,
                                                )
                                                .toList(),
                                    });
                                  },
                          ),
                      ],
                    ],
                  ),
                ),
              );
            },
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller,
        actions = controller.actions,
        run = _run,
        definition = _definition;
    if (actions == null || !_current) {
      return const SizedBox.shrink();
    }
    final history =
        controller.advancedReads[AccountAdvancedKind.workflows]!.value;
    final runs = accountList(history?.raw['runs'] ?? [], 100, accountMap);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'Workflow setup creates an idle project and open tasks. Execution remains a separate governed action.',
        ),
        if (_reading) const Text('Reading exact workflow sources…'),
        if (_error != null) Semantics(liveRegion: true, child: Text(_error!)),
        if (definition == null && run == null) ...[
          DropdownButtonFormField<String>(
            initialValue: null,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'New workflow'),
            items: [
              for (final item in _pack)
                DropdownMenuItem(
                  value: item['workflowId'] as String,
                  child: Text(item['name'] as String),
                ),
            ],
            onChanged: !_editable
                ? null
                : (id) => _choose(
                    _pack.singleWhere((row) => row['workflowId'] == id),
                  ),
          ),
          for (final item in runs)
            ListTile(
              title: Text(
                '${item['workflowId']} · ${(item['outcome'] as Map)['status']}',
              ),
              subtitle: Text(item['runId'] as String),
              trailing: OutlinedButton(
                onPressed: _reading
                    ? null
                    : () => _openRun(item['runId'] as String),
                child: const Text('Inspect exact run'),
              ),
            ),
          TextField(
            controller: _exactRun,
            decoration: const InputDecoration(
              labelText: 'Bookmarked workflow run ID',
            ),
            onSubmitted: _openRun,
          ),
          OutlinedButton(
            onPressed: _reading ? null : () => _openRun(_exactRun.text),
            child: const Text('Open exact workflow run'),
          ),
        ] else ...[
          OutlinedButton(
            onPressed: () => setState(_clear),
            child: const Text('Close workflow review'),
          ),
          if (run != null) ...[
            Text(
              'Current run revision ${run.run['revision']} · ${(run.run['outcome'] as Map)['status']}',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            Text(
              (run.run['outcome']['summary'] as String).isEmpty
                  ? 'No completed outcome has been recorded.'
                  : 'Recorded summary: ${run.run['outcome']['summary']}',
            ),
            Text('Recorded next action: ${run.run['outcome']['nextAction']}'),
            SelectableText(
              'Original Account: ${run.run['accountRevisionId']}\nCurrent Account: ${run.raw['currentAccount']['revisionId']}\nProject: ${run.run['projectId']}',
            ),
            ExpansionTile(
              title: const Text('Recorded input and artifact evidence'),
              children: [
                SelectableText(
                  const JsonEncoder.withIndent('  ').convert({
                    'input': run.run['input'],
                    'outcome': run.run['outcome'],
                  }),
                ),
              ],
            ),
            if (run.progress['state'] == 'available') ...[
              Text(
                'Project execution: ${run.progress['executionStatus']} · autonomy: ${run.progress['autonomyMode']}',
              ),
              for (final task in accountList(
                run.progress['tasks'],
                20,
                accountMap,
              ))
                Text('${task['title']} · ${task['status']}'),
            ] else
              const Text(
                'Current project progress is unavailable. This does not negate an accepted setup or outcome.',
              ),
            OutlinedButton(
              onPressed: _reading || actions.busy
                  ? null
                  : () => _openRun(run.run['runId'] as String),
              child: const Text('Refresh exact workflow run'),
            ),
            if (definition == null)
              const Text(
                'The original workflow definition is unavailable in this release. The run remains readable; outcome recording is disabled.',
              ),
          ],
          if (definition != null) ...[
            Text(
              definition['name'] as String,
              style: Theme.of(context).textTheme.titleLarge,
            ),
            Text(definition['description'] as String),
            ExpansionTile(
              title: const Text('Plan, evidence and acceptance criteria'),
              children: [
                for (final criterion
                    in definition['acceptanceCriteria'] as List)
                  ListTile(title: Text(criterion as String)),
                for (final task in accountList(
                  accountMap(definition['projectTemplate'])['tasks'],
                  20,
                  accountMap,
                ))
                  ListTile(
                    title: Text(task['title'] as String),
                    subtitle: Text(task['detail'] as String),
                  ),
                for (final evidence in accountList(
                  definition['evidenceRequirements'],
                  20,
                  accountMap,
                ))
                  ListTile(
                    title: Text(evidence['title'] as String),
                    subtitle: Text(evidence['description'] as String),
                  ),
              ],
            ),
            if (run == null) ...[
              for (final field in accountList(
                definition['inputFields'],
                20,
                accountMap,
              ))
                _field(field),
            ] else if (!const {
              'completed',
              'cancelled',
            }.contains(accountMap(run.run['outcome'])['status'])) ...[
              DropdownButtonFormField<String>(
                initialValue: _values['status'] as String? ?? 'blocked',
                isExpanded: true,
                decoration: const InputDecoration(
                  labelText: 'Recorded outcome',
                ),
                items: [
                  for (final status in ['completed', 'blocked', 'cancelled'])
                    DropdownMenuItem(value: status, child: Text(status)),
                ],
                onChanged: _editable
                    ? (status) => _change('status', status)
                    : null,
              ),
              _text('summary', 'Outcome summary', lines: 3, maxLength: 4000),
              _text('nextAction', 'Next action', lines: 2, maxLength: 500),
              _outcomeArtifacts(),
            ],
            if (run == null ||
                !const {
                  'completed',
                  'cancelled',
                }.contains(accountMap(run.run['outcome'])['status'])) ...[
              OutlinedButton(
                onPressed:
                    _editable &&
                        _definitionCurrent &&
                        actions.workflowWritable(start: run == null)
                    ? _review
                    : null,
                child: Text(
                  run == null
                      ? 'Review workflow setup'
                      : 'Review recorded outcome',
                ),
              ),
              if (_reviewValues != null && _reviewedAccount != null)
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Review for ${_reviewedAccount!.name} · Account revision ${_reviewedAccount!.revision}',
                        ),
                        SelectableText(
                          const JsonEncoder.withIndent('  ')
                              .convert(_reviewValues),
                        ),
                        const Text(
                          'Confirm only these reviewed values. This action does not execute tasks, send messages or change Salesforce.',
                        ),
                        FilledButton(
                          onPressed: _editable && _definitionCurrent
                              ? _confirm
                              : null,
                          child: Text(
                            run == null
                                ? 'Confirm workflow setup'
                                : 'Confirm recorded outcome',
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ],
        ],
      ],
    );
  }
}

class AccountWorkflowRecovery extends StatelessWidget {
  const AccountWorkflowRecovery({super.key, required this.controller});
  final AccountsController controller;
  @override
  Widget build(BuildContext context) {
    final actions = controller.actions,
        pending = controller.actions?.pendingWorkflow,
        receipt = controller.actions?.acceptedWorkflow?.acceptance;
    if (actions == null || !actions.available) {
      return const SizedBox.shrink();
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (pending != null) ...[
          Text(
            'Unconfirmed workflow ${pending.start ? 'setup' : 'outcome'}',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          SelectableText(
            'Account: ${pending.accountName}\nRun: ${pending.runId}\nRequest: ${pending.requestSha256}',
          ),
          const Text(
            'Recovery only reads the exact original acceptance. It never starts a workflow or resubmits an outcome.',
          ),
          OutlinedButton(
            onPressed: !actions.busy && !actions.storageUnconfirmed
                ? actions.recoverWorkflow
                : null,
            child: const Text('Read exact workflow acceptance'),
          ),
        ],
        if (receipt != null)
          ExpansionTile(
            title: Text(
              'Accepted workflow ${receipt['operation']} · ${receipt['outcomeStatus']}',
            ),
            children: [
              SelectableText(
                'Run: ${receipt['runRevisionId']}\nReviewed Account: ${receipt['reviewedAccountRevisionId']}\nOriginal Account: ${receipt['runAccountRevisionId']}\nProject: ${receipt['projectId']}\nAccepted: ${receipt['acceptedAt']}\nAcceptance: ${receipt['acceptanceSha256']}',
              ),
              const Text(
                'This immutable acceptance grants no external effect authority. Current project progress may be newer.',
              ),
            ],
          ),
        if (actions.storageUnconfirmed &&
            pending == null &&
            (receipt != null || actions.workflowNotSubmitted != null))
          OutlinedButton(
            onPressed: actions.busy ? null : actions.settleWorkflowLocally,
            child: const Text('Save workflow recovery locally'),
          ),
      ],
    );
  }
}
