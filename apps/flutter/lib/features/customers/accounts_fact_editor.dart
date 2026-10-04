import 'package:flutter/material.dart';

import 'accounts_contracts.dart';

/// A reviewed manual assertion. Transport and durable recovery belong to the
/// shared Account action controller supplied by the caller.
class AccountFactEditor extends StatefulWidget {
  const AccountFactEditor({
    super.key,
    required this.account,
    required this.facts,
    required this.owner,
    required this.enabled,
    required this.onDraftChanged,
    required this.onSubmit,
    this.draft,
  });
  final CustomerAccountSummary account;
  final List<CustomerFact> facts;
  final AccountsOwner owner;
  final bool enabled;
  final AccountJson? draft;
  final ValueChanged<AccountJson> onDraftChanged;
  final Future<void> Function(AccountJson request) onSubmit;
  @override
  State<AccountFactEditor> createState() => _AccountFactEditorState();
}

class _FactField {
  const _FactField(
    this.key,
    this.label, {
    this.type = 'text',
    this.optional = false,
    this.max = 240,
    this.options = const [],
  });
  final String key, label, type;
  final bool optional;
  final int max;
  final List<String> options;
}

const _factFields = <String, List<_FactField>>{
  'organization': [
    _FactField('entityId', 'Organization reference'),
    _FactField('name', 'Name'),
    _FactField('industry', 'Industry', optional: true, max: 160),
    _FactField('website', 'Website', optional: true, max: 2000),
  ],
  'contact': [
    _FactField('entityId', 'Contact reference'),
    _FactField('name', 'Name'),
    _FactField('email', 'Email', optional: true, max: 320),
    _FactField('title', 'Job title', optional: true, max: 180),
  ],
  'stakeholder': [
    _FactField('entityId', 'Stakeholder reference'),
    _FactField('name', 'Name'),
    _FactField('role', 'Role', max: 180),
    _FactField(
      'influence',
      'Influence',
      options: ['low', 'medium', 'high', 'unknown'],
    ),
    _FactField(
      'stance',
      'Stance',
      options: ['champion', 'supportive', 'neutral', 'detractor', 'unknown'],
    ),
  ],
  'product': [
    _FactField('entityId', 'Product reference'),
    _FactField('name', 'Name'),
    _FactField(
      'status',
      'Status',
      options: ['trial', 'active', 'paused', 'ended', 'unknown'],
    ),
    _FactField('quantity', 'Quantity', type: 'number', optional: true),
  ],
  'opportunity': [
    _FactField('entityId', 'Opportunity reference'),
    _FactField('name', 'Name'),
    _FactField('stage', 'Stage', max: 120),
    _FactField(
      'amountMinor',
      'Amount in minor currency units',
      type: 'integer',
      optional: true,
    ),
    _FactField('currency', 'Currency code', optional: true, max: 3),
    _FactField(
      'expectedCloseAt',
      'Expected close',
      type: 'date',
      optional: true,
    ),
  ],
  'case': [
    _FactField('entityId', 'Case reference'),
    _FactField('title', 'Title', max: 500),
    _FactField('status', 'Status', max: 120),
    _FactField(
      'severity',
      'Severity',
      options: ['low', 'medium', 'high', 'critical', 'unknown'],
    ),
  ],
  'usage': [
    _FactField('metricId', 'Metric reference'),
    _FactField('label', 'Metric name'),
    _FactField('value', 'Value', type: 'number'),
    _FactField('unit', 'Unit', max: 80),
    _FactField('periodStartAt', 'Period start', type: 'date'),
    _FactField('periodEndAt', 'Period end', type: 'date'),
  ],
  'project': [
    _FactField('projectId', 'Project reference'),
    _FactField('name', 'Name'),
    _FactField('status', 'Status', max: 120),
  ],
  'interaction': [
    _FactField('interactionId', 'Interaction reference'),
    _FactField(
      'channel',
      'Channel',
      options: ['meeting', 'email', 'call', 'message', 'support', 'other'],
    ),
    _FactField('summary', 'Summary', max: 4000),
    _FactField('occurredAt', 'Occurred', type: 'date'),
  ],
  'health': [
    _FactField('dimension', 'Dimension', max: 120),
    _FactField(
      'status',
      'Status',
      options: ['healthy', 'watch', 'at_risk', 'unknown'],
    ),
    _FactField(
      'scoreBasisPoints',
      'Score (0–10,000)',
      type: 'integer',
      optional: true,
    ),
    _FactField('summary', 'Summary', max: 2000),
  ],
  'risk': [
    _FactField('entityId', 'Risk reference'),
    _FactField('title', 'Title', max: 500),
    _FactField(
      'severity',
      'Severity',
      options: ['low', 'medium', 'high', 'critical'],
    ),
    _FactField('status', 'Status', options: ['open', 'mitigating', 'resolved']),
  ],
  'renewal': [
    _FactField('renewalId', 'Renewal reference'),
    _FactField(
      'status',
      'Status',
      options: [
        'unplanned',
        'planning',
        'proposed',
        'committed',
        'renewed',
        'lost',
      ],
    ),
    _FactField('renewalAt', 'Renewal date', type: 'date'),
    _FactField(
      'amountMinor',
      'Amount in minor currency units',
      type: 'integer',
      optional: true,
    ),
    _FactField('currency', 'Currency code', optional: true, max: 3),
  ],
};

class _AccountFactEditorState extends State<AccountFactEditor> {
  final _texts = <String, TextEditingController>{};
  AccountJson _draft = {}, _values = {};
  AccountJson? _review;
  String? _error;
  int _epoch = 0;
  bool _sending = false;
  String get _operation => _draft['operation'] as String? ?? 'create';
  String get _kind => _draft['kind'] as String? ?? 'organization';
  bool get _editable => widget.enabled && !_sending;
  List<CustomerFact> get _manualFacts => widget.facts
      .where(
        (fact) =>
            fact.source['sourceKind'] == 'manual' &&
            fact.source['permissionBasis'] == 'operator_assertion',
      )
      .toList();
  CustomerFact? get _currentFact =>
      _manualFacts.where((fact) => fact.id == _draft['factId']).firstOrNull;
  bool get _pinCurrent =>
      _operation == 'create' ||
      (_currentFact != null &&
          _currentFact!.fact['revision'] == _draft['expectedFactRevision'] &&
          _currentFact!.fact['factSha256'] == _draft['expectedFactSha256']);
  List<String> get _allowedPurposes => List<String>.from(
    accountMap(widget.account.raw['crmPermissions'])['customerDataPurposeIds']
        as List,
  )..sort();

  @override
  void initState() {
    super.initState();
    _load(widget.draft);
  }

  @override
  void didUpdateWidget(covariant AccountFactEditor oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.owner.key != widget.owner.key ||
        oldWidget.account.id != widget.account.id) {
      _epoch++;
      _sending = false;
      _load(widget.draft);
    } else if (oldWidget.account.sha256 != widget.account.sha256 ||
        !_pinCurrent ||
        !widget.enabled) {
      _review = null;
    }
  }

  @override
  void dispose() {
    _epoch++;
    _disposeTexts();
    super.dispose();
  }

  void _disposeTexts() {
    for (final field in _texts.values) {
      field.dispose();
    }
    _texts.clear();
  }

  String _now() => DateTime.fromMillisecondsSinceEpoch(
    DateTime.now().millisecondsSinceEpoch,
    isUtc: true,
  ).toIso8601String();
  bool _savedUsable(AccountJson? saved) {
    if (saved == null ||
        saved['accountId'] != widget.account.id ||
        saved['ownerKey'] != widget.owner.key) {
      return false;
    }
    try {
      accountKeys(saved, [
        'accountId',
        'ownerKey',
        'operation',
        'kind',
        'factId',
        'expectedFactRevision',
        'expectedFactSha256',
        'factKey',
        'owner',
        'confidenceBasisPoints',
        'validFrom',
        'validTo',
        'staleAfter',
        'manualSource',
        'allowedPurposeIds',
        'values',
      ]);
      accountEnum(saved['operation'], ['create', 'revise', 'retract']);
      accountRequire(_factFields.containsKey(saved['kind']));
      final values = accountMap(saved['values']);
      accountRequire(
        values.keys.every(
          (key) => _factFields[saved['kind']]!.any((field) => field.key == key),
        ),
      );
      for (final value in values.values) {
        accountRequire(
          value == null ||
              (value is String && value.length <= 4000) ||
              (value is num && value.isFinite),
        );
      }
      accountRequire(
        saved['factKey'] is String &&
            (saved['factKey'] as String).length <= 160,
      );
      accountSemanticOwner(saved['owner']);
      accountInt(saved['confidenceBasisPoints'], max: 10000);
      accountDate(saved['validFrom']);
      accountNullable(saved['validTo'], accountDate);
      accountNullable(saved['staleAfter'], accountDate);
      final source = accountMap(saved['manualSource']);
      accountKeys(source, ['label', 'observedAt']);
      accountRequire(
        source['label'] is String && (source['label'] as String).length <= 240,
      );
      accountDate(source['observedAt']);
      final purposes = accountList(
        saved['allowedPurposeIds'],
        5,
        (value) => accountEnum(value, accountPurposes),
      );
      accountUnique(purposes);
      accountRequire(purposes.contains('customer_success.account.read'));
      if (saved['operation'] != 'create') {
        accountId(saved['factId'], 'customer-fact');
        accountInt(saved['expectedFactRevision'], min: 1, max: 2147483647);
        accountHash(saved['expectedFactSha256']);
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  void _load(AccountJson? saved) {
    _disposeTexts();
    _review = null;
    _error = null;
    if (_savedUsable(saved)) {
      _draft = accountMap(accountFreeze(saved!));
      _values = Map<String, dynamic>.from(accountMap(_draft['values']));
    } else {
      final now = _now();
      _draft = {
        'accountId': widget.account.id,
        'ownerKey': widget.owner.key,
        'operation': 'create',
        'kind': 'organization',
        'factId': null,
        'expectedFactRevision': null,
        'expectedFactSha256': null,
        'factKey': '',
        'owner': widget.account.raw['accountOwner'],
        'confidenceBasisPoints': 5000,
        'validFrom': now,
        'validTo': null,
        'staleAfter': null,
        'manualSource': {'label': 'Manual entry', 'observedAt': now},
        'allowedPurposeIds': _allowedPurposes,
      };
      _values = {};
    }
    _draft = Map<String, dynamic>.from(_draft);
  }

  void _changed() {
    _review = null;
    _error = null;
    _draft['values'] = Map<String, dynamic>.from(_values);
    widget.onDraftChanged(accountFreeze(_draft));
  }

  void _set(String key, Object? value) {
    setState(() {
      _draft[key] = value;
      _changed();
    });
  }

  void _value(String key, Object? value) {
    setState(() {
      _values[key] = value;
      _changed();
    });
  }

  void _chooseFact(CustomerFact fact) {
    setState(() {
      _disposeTexts();
      final row = fact.fact;
      _draft.addAll({
        'factId': fact.id,
        'expectedFactRevision': row['revision'],
        'expectedFactSha256': row['factSha256'],
        'kind': fact.kind,
        'factKey': fact.key,
        'owner': row['owner'],
        'confidenceBasisPoints': row['confidenceBasisPoints'],
        'validFrom': row['validFrom'],
        'validTo': row['validTo'],
        'staleAfter': row['staleAfter'],
        'manualSource': {
          'label': fact.source['sourceLabel'],
          'observedAt': _now(),
        },
        'allowedPurposeIds':
            (fact.source['allowedPurposeIds'] as List)
                .where(_allowedPurposes.contains)
                .toList()
              ..sort(),
      });
      _values = Map<String, dynamic>.from(fact.value);
      _values.remove('kind');
      _changed();
    });
  }

  AccountJson _request() {
    accountRequire(
      _pinCurrent,
      'This fact changed. Load its latest version before reviewing.',
    );
    final values = <String, dynamic>{'kind': _kind};
    for (final field in _factFields[_kind]!) {
      final raw = _values[field.key];
      final text = raw?.toString().trim() ?? '';
      if (field.optional && text.isEmpty) {
        values[field.key] = null;
      } else if (field.type == 'integer') {
        values[field.key] = int.tryParse(text);
        accountRequire(
          values[field.key] != null,
          'Enter a whole number for ${field.label}.',
        );
      } else if (field.type == 'number') {
        values[field.key] = num.tryParse(text);
        accountRequire(
          values[field.key] != null && (values[field.key] as num).isFinite,
          'Enter a finite number for ${field.label}.',
        );
      } else if (field.type == 'date') {
        values[field.key] = accountDate(raw);
      } else {
        values[field.key] = field.key == 'currency' ? text.toUpperCase() : text;
      }
    }
    accountFactValue(values, _kind);
    final owner = accountMap(_draft['owner']);
    accountSemanticOwner(owner);
    final purposes = List<String>.from(_draft['allowedPurposeIds'] as List)
      ..sort();
    accountRequire(
      purposes.contains('customer_success.account.read') &&
          purposes.every(_allowedPurposes.contains),
      'Review the current allowed data purposes.',
    );
    final source = accountMap(_draft['manualSource']);
    final validFrom = accountDate(_draft['validFrom']);
    final validTo = _draft['validTo'] == null
        ? null
        : accountDate(_draft['validTo']);
    final staleAfter = _draft['staleAfter'] == null
        ? null
        : accountDate(_draft['staleAfter']);
    accountRequire(
      validTo == null || validTo.compareTo(validFrom) > 0,
      'The end of validity must follow its start.',
    );
    accountRequire(
      staleAfter == null ||
          staleAfter.compareTo(accountDate(source['observedAt'])) > 0,
      'The stale date must follow the observation.',
    );
    final factKey = accountText(
      (_draft['factKey'] as String? ?? '').trim(),
      160,
    );
    accountRequire(
      RegExp(r'^[a-z0-9][a-z0-9._:-]*$').hasMatch(factKey),
      'Use a lowercase field name with letters, numbers, dots, colons, hyphens or underscores.',
    );
    return accountFreeze({
      'contract': 'customer-fact-mutation-request:1',
      'workspaceId': widget.account.raw['workspaceId'],
      'expectedAccountRevision': widget.account.revision,
      'expectedAccountSha256': widget.account.sha256,
      'operation': _operation,
      'factId': _operation == 'create' ? null : _draft['factId'],
      'expectedFactRevision': _operation == 'create'
          ? null
          : _draft['expectedFactRevision'],
      'expectedFactSha256': _operation == 'create'
          ? null
          : _draft['expectedFactSha256'],
      'factKey': factKey,
      'value': values,
      'owner': owner,
      'confidenceBasisPoints': accountInt(
        _draft['confidenceBasisPoints'],
        max: 10000,
      ),
      'validFrom': validFrom,
      'validTo': validTo,
      'staleAfter': staleAfter,
      'manualSource': {
        'label': accountText((source['label'] as String? ?? '').trim(), 240),
        'observedAt': accountDate(source['observedAt']),
      },
      'allowedPurposeIds': purposes,
    });
  }

  void _prepareReview() {
    if (!_editable) {
      return;
    }
    try {
      final request = _request();
      setState(() {
        _review = request;
        _error = null;
      });
    } catch (error) {
      setState(
        () => _error = error is FormatException
            ? error.message
            : 'Complete the required fields before reviewing.',
      );
    }
  }

  Future<void> _submit() async {
    final reviewed = _review, epoch = _epoch, ownerKey = widget.owner.key;
    if (!_editable || reviewed == null) {
      return;
    }
    try {
      accountRequire(
        accountCanonical(_request()) == accountCanonical(reviewed),
        'The reviewed entry changed. Review it again.',
      );
      setState(() {
        _sending = true;
        _error = null;
      });
      try {
        await widget.onSubmit(reviewed);
      } finally {
        if (mounted && epoch == _epoch) {
          setState(() {
            _sending = false;
            _review = null;
          });
        }
      }
    } catch (error) {
      if (mounted && epoch == _epoch && widget.owner.key == ownerKey) {
        setState(
          () => _error = error is FormatException ? error.message : 'The change could not be confirmed. Check the saved Account action status before trying another change.',
        );
      }
    }
  }

  TextEditingController _text(String key, Object? value) => _texts.putIfAbsent(
    key,
    () => TextEditingController(text: value?.toString() ?? ''),
  );
  Widget _input(
    String key,
    String label,
    Object? value,
    ValueChanged<String> change, {
    int max = 240,
    bool enabled = true,
    bool number = false,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: TextField(
      controller: _text(key, value),
      enabled: _editable && enabled,
      maxLength: max,
      minLines: 1,
      maxLines: max > 500 ? 4 : 1,
      keyboardType: number
          ? const TextInputType.numberWithOptions(decimal: true, signed: true)
          : TextInputType.text,
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
      ),
      onChanged: change,
    ),
  );
  Widget _date(
    String label,
    Object? raw,
    ValueChanged<String?> change, {
    bool optional = false,
    bool enabled = true,
  }) {
    final parsed = raw is String ? DateTime.tryParse(raw) : null;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: Theme.of(context).textTheme.labelLarge),
          Text(parsed == null ? 'Not set' : '${parsed.toLocal()} (local time)'),
          Wrap(
            spacing: 8,
            children: [
              OutlinedButton(
                onPressed: !_editable || !enabled
                    ? null
                    : () async {
                        final epoch = _epoch,
                            initial = parsed?.toLocal() ?? DateTime.now();
                        final day = await showDatePicker(
                          context: context,
                          initialDate: initial,
                          firstDate: DateTime(1),
                          lastDate: DateTime(9999, 12, 31),
                        );
                        if (!mounted ||
                            epoch != _epoch ||
                            day == null ||
                            !_editable) {
                          return;
                        }
                        final time = await showTimePicker(
                          context: context,
                          initialTime: TimeOfDay.fromDateTime(initial),
                        );
                        if (!mounted ||
                            epoch != _epoch ||
                            time == null ||
                            !_editable) {
                          return;
                        }
                        change(
                          DateTime(
                            day.year,
                            day.month,
                            day.day,
                            time.hour,
                            time.minute,
                          ).toUtc().toIso8601String(),
                        );
                      },
                child: const Text('Choose date and time'),
              ),
              if (optional)
                TextButton(
                  onPressed: _editable && enabled && raw != null
                      ? () => change(null)
                      : null,
                  child: const Text('Clear'),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _valueField(_FactField field) {
    final enabled = _operation != 'retract';
    if (field.type == 'date') {
      return _date(
        field.label,
        _values[field.key],
        (value) => _value(field.key, value),
        optional: field.optional,
        enabled: enabled,
      );
    }
    if (field.options.isNotEmpty) {
      return Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: DropdownButtonFormField<String>(
          key: ValueKey('$_kind-${field.key}-${_values[field.key]}'),
          isExpanded: true,
          initialValue: field.options.contains(_values[field.key])
              ? _values[field.key] as String
              : null,
          decoration: InputDecoration(
            labelText: field.label,
            border: const OutlineInputBorder(),
          ),
          items: field.options
              .map(
                (value) => DropdownMenuItem(
                  value: value,
                  child: Text(value.replaceAll('_', ' ')),
                ),
              )
              .toList(),
          onChanged: !_editable || !enabled
              ? null
              : (value) => _value(field.key, value),
        ),
      );
    }
    return _input(
      'value.${field.key}',
      '${field.label}${field.optional ? ' (optional)' : ''}',
      _values[field.key],
      (value) => _value(field.key, value),
      max: field.max,
      enabled: enabled,
      number: ['integer', 'number'].contains(field.type),
    );
  }

  @override
  Widget build(BuildContext context) {
    final selected = _currentFact, source = accountMap(_draft['manualSource']);
    final purposes = List<String>.from(_draft['allowedPurposeIds'] as List);
    final owner = accountMap(_draft['owner']);
    final ownerChoices = <String, AccountJson>{};
    for (final item in [
      accountMap(widget.account.raw['accountOwner']),
      ...widget.facts.map((fact) => accountMap(fact.fact['owner'])),
      owner,
    ]) {
      ownerChoices[accountCanonical(item)] = item;
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Manual account facts',
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 8),
        const Text(
          'Record an observation with its source, owner and confidence. Manual entries remain operator assertions. Connected-source facts keep their original provenance.',
        ),
        const SizedBox(height: 12),
        DropdownButtonFormField<String>(
          key: ValueKey('operation-$_operation'),
          initialValue: _operation,
          isExpanded: true,
          decoration: const InputDecoration(
            labelText: 'Action',
            border: OutlineInputBorder(),
          ),
          items: const [
            DropdownMenuItem(value: 'create', child: Text('Add a fact')),
            DropdownMenuItem(
              value: 'revise',
              child: Text('Revise a manual fact'),
            ),
            DropdownMenuItem(
              value: 'retract',
              child: Text('Retract a manual fact'),
            ),
          ],
          onChanged: !_editable
              ? null
              : (value) {
                  if (value != null) {
                    setState(() {
                      _draft['operation'] = value;
                      _changed();
                    });
                  }
                },
        ),
        const SizedBox(height: 12),
        if (_operation != 'create') ...[
          DropdownButtonFormField<String>(
            key: ValueKey('fact-${selected?.id}'),
            initialValue: selected?.id,
            isExpanded: true,
            decoration: const InputDecoration(
              labelText: 'Manual fact',
              border: OutlineInputBorder(),
            ),
            items: _manualFacts
                .map(
                  (fact) => DropdownMenuItem(
                    value: fact.id,
                    child: Text(
                      '${fact.key}: ${fact.summary}',
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                )
                .toList(),
            onChanged: !_editable
                ? null
                : (id) {
                    final fact = _manualFacts
                        .where((item) => item.id == id)
                        .firstOrNull;
                    if (fact != null) {
                      _chooseFact(fact);
                    }
                  },
          ),
          if (_manualFacts.isEmpty)
            const Text(
              'There are no editable manual facts in the current Account view.',
            ),
          if (!_pinCurrent) ...[
            const Text(
              'The saved fact is no longer current. Load its latest version to review your change.',
            ),
            if (selected != null)
              TextButton(
                onPressed: _editable ? () => _chooseFact(selected) : null,
                child: const Text('Load latest fact'),
              ),
          ],
          const SizedBox(height: 12),
        ],
        if (_operation == 'create') ...[
          DropdownButtonFormField<String>(
            key: ValueKey('kind-$_kind'),
            initialValue: _kind,
            isExpanded: true,
            decoration: const InputDecoration(
              labelText: 'Fact type',
              border: OutlineInputBorder(),
            ),
            items: _factFields.keys
                .map((kind) => DropdownMenuItem(value: kind, child: Text(kind)))
                .toList(),
            onChanged: !_editable
                ? null
                : (value) {
                    if (value != null) {
                      setState(() {
                        _disposeTexts();
                        _draft['kind'] = value;
                        _values = {};
                        _changed();
                      });
                    }
                  },
          ),
          const SizedBox(height: 12),
        ],
        _input(
          'factKey',
          'Field name',
          _draft['factKey'],
          (value) => _set('factKey', value),
          max: 160,
          enabled: _operation == 'create',
        ),
        for (final field in _factFields[_kind]!) _valueField(field),
        DropdownButtonFormField<String>(
          key: ValueKey('owner-${accountCanonical(owner)}'),
          initialValue: accountCanonical(owner),
          isExpanded: true,
          decoration: const InputDecoration(
            labelText: 'Owner',
            border: OutlineInputBorder(),
          ),
          items: ownerChoices.entries
              .map(
                (item) => DropdownMenuItem(
                  value: item.key,
                  child: Text(
                    '${item.value['displayName']} (${item.value['ownerKind']})',
                  ),
                ),
              )
              .toList(),
          onChanged: !_editable
              ? null
              : (value) {
                  if (value != null) {
                    _set('owner', ownerChoices[value]);
                  }
                },
        ),
        const SizedBox(height: 12),
        Text('Confidence: ${(_draft['confidenceBasisPoints'] as num) / 100}%'),
        Slider(
          value: (_draft['confidenceBasisPoints'] as num).toDouble(),
          min: 0,
          max: 10000,
          divisions: 100,
          label: '${(_draft['confidenceBasisPoints'] as num) / 100}%',
          onChanged: !_editable
              ? null
              : (value) => _set('confidenceBasisPoints', value.round()),
        ),
        _input(
          'source.label',
          'Source description',
          source['label'],
          (value) => _set('manualSource', {...source, 'label': value}),
        ),
        _date(
          'Observed',
          source['observedAt'],
          (value) => _set('manualSource', {...source, 'observedAt': value}),
        ),
        _date(
          'Valid from',
          _draft['validFrom'],
          (value) => _set('validFrom', value),
        ),
        _date(
          'Valid until',
          _draft['validTo'],
          (value) => _set('validTo', value),
          optional: true,
        ),
        _date(
          'Consider stale after',
          _draft['staleAfter'],
          (value) => _set('staleAfter', value),
          optional: true,
        ),
        Text('Allowed uses', style: Theme.of(context).textTheme.titleSmall),
        for (final purpose in _allowedPurposes)
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            title: Text(
              purpose
                  .replaceFirst('customer_success.', '')
                  .replaceAll('_', ' '),
            ),
            value: purposes.contains(purpose),
            onChanged: !_editable || purpose == 'customer_success.account.read'
                ? null
                : (checked) {
                    final changed = [...purposes]..remove(purpose);
                    if (checked == true) {
                      changed.add(purpose);
                    }
                    changed.sort();
                    _set('allowedPurposeIds', changed);
                  },
          ),
        if (_operation == 'retract')
          const Text(
            'Retraction adds a historical revision marked retracted. Earlier evidence and competing facts remain visible.',
          ),
        if (selected != null && selected.conflictingIds.isNotEmpty)
          Text(
            'This fact has ${selected.conflictingIds.length} competing fact(s). Saving this entry does not resolve them.',
          ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Text(
              _error!,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ),
        if (_review == null)
          FilledButton(
            onPressed: _editable && _pinCurrent ? _prepareReview : null,
            child: const Text('Review fact'),
          )
        else ...[
          const Divider(height: 24),
          Text(
            'Review ${_review!['operation']} for ${widget.account.name}',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          Text('${_review!['factKey']} · $_kind · ${owner['displayName']}'),
          for (final field in _factFields[_kind]!)
            Text(
              '${field.label}: ${accountMap(_review!['value'])[field.key] ?? 'not set'}',
            ),
          Text(
            'Source: ${accountMap(_review!['manualSource'])['label']}\nConfidence: ${(_review!['confidenceBasisPoints'] as num) / 100}%',
          ),
          const Text(
            'The current Account and selected fact version will be checked before saving. A lost response is recovered from the saved action receipt.',
          ),
          const SizedBox(height: 8),
          FilledButton(
            onPressed: _editable ? _submit : null,
            child: Text(
              _sending
                  ? 'Saving…'
                  : _operation == 'retract'
                  ? 'Confirm retraction'
                  : 'Confirm fact',
            ),
          ),
          TextButton(
            onPressed: _sending ? null : () => setState(() => _review = null),
            child: const Text('Return to editing'),
          ),
        ],
      ],
    );
  }
}
