import 'package:flutter/material.dart';

import 'knowledge.dart';
import 'knowledge_build_contracts.dart';
import 'knowledge_maintenance_contracts.dart';
import 'knowledge_mutations.dart';
import 'knowledge_mutation_widgets.dart';
import 'knowledge_private_action_contracts.dart';

class KnowledgeOperations extends StatefulWidget {
  const KnowledgeOperations({
    super.key,
    required this.controller,
    this.active = true,
  });
  final KnowledgeController controller;
  final bool active;
  @override
  State<KnowledgeOperations> createState() => _KnowledgeOperationsState();
}

class _KnowledgeOperationsState extends State<KnowledgeOperations>
    with WidgetsBindingObserver {
  final _document = TextEditingController();
  String _kind = 'maintenance';
  KnowledgeMaintenanceReview? _review;
  KnowledgeBuildReview? _build;
  KnowledgeBuildRead? _processing;
  String? _error;
  bool _reading = false,
      _saving = false,
      _confirmed = false,
      _foreground = true;
  int _epoch = 0;
  bool get _current =>
      mounted && widget.active && _foreground && widget.controller.available;
  MemoryChange get _change => _kind == 'maintenance'
      ? MemoryChange.maintenance
      : _kind == 'graph'
      ? MemoryChange.graphRebuild
      : MemoryChange.cognitionBuild;
  bool get _supported => _kind == 'build'
      ? widget.controller.buildsAvailable
      : widget.controller.maintenanceAvailable(_kind);
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
  }

  void _reset() {
    _epoch++;
    _review = null;
    _build = null;
    _processing = null;
    _error = null;
    _reading = _saving = _confirmed = false;
  }

  @override
  void didUpdateWidget(covariant KnowledgeOperations oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(widget.controller, oldWidget.controller) ||
        widget.active != oldWidget.active) {
      _reset();
      _document.clear();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    setState(() {
      _reset();
      _document.clear();
    });
  }

  @override
  void dispose() {
    _epoch++;
    WidgetsBinding.instance.removeObserver(this);
    _document.dispose();
    super.dispose();
  }

  void _select(String kind) => setState(() {
    _reset();
    _kind = kind;
  });
  void _selectDocument(String id) => setState(() {
    _reset();
    _document.text = id;
  });
  String _failure(Object error) => error is FormatException
      ? error.message
      : 'The current action could not be confirmed. Retry the read. Any saved submission or accepted receipt remains protected below.';
  Future<void> _read() async {
    if (!_current || !_supported || _saving) {
      return;
    }
    final controller = widget.controller,
        epoch = ++_epoch,
        kind = _kind,
        id = _document.text.trim();
    bool current() =>
        _current && identical(controller, widget.controller) && epoch == _epoch;
    setState(() {
      _reading = true;
      _review = null;
      _build = null;
      _confirmed = false;
      _error = null;
    });
    try {
      if (kind == 'build') {
        final result = await controller.inspectBuild(id);
        if (current()) {
          setState(() => _build = result);
        }
      } else {
        final result = await controller.inspectMaintenance(kind);
        if (current()) {
          setState(() => _review = result);
        }
      }
    } catch (error) {
      if (current()) {
        setState(() => _error = _failure(error));
      }
    } finally {
      if (current()) {
        setState(() => _reading = false);
      }
    }
  }

  Future<void> _submit() async {
    final controller = widget.controller,
        epoch = _epoch,
        review = _review,
        build = _build;
    bool current() =>
        _current &&
        identical(widget.controller, controller) &&
        epoch == _epoch &&
        identical(_review, review) &&
        identical(_build, build) &&
        _confirmed &&
        !_reading &&
        _error == null;
    if (!current() || _saving) {
      return;
    }
    setState(() => _saving = true);
    try {
      if (build != null) {
        await controller.buildReviewedDocument(build, isReviewCurrent: current);
      } else if (review != null) {
        await controller.runReviewedMaintenance(
          review,
          isReviewCurrent: current,
        );
      }
      if (current()) {
        setState(() {
          _review = null;
          _build = null;
          _confirmed = false;
        });
      }
    } catch (error) {
      if (current()) {
        setState(() => _error = _failure(error));
      }
    } finally {
      if (mounted &&
          identical(controller, widget.controller) &&
          epoch == _epoch) {
        setState(() => _saving = false);
      }
    }
  }

  Future<void> _readProcessing(MemoryAcceptance accepted) async {
    if (!_current || _reading || _saving) {
      return;
    }
    final controller = widget.controller, epoch = ++_epoch;
    bool current() =>
        _current &&
        identical(controller, widget.controller) &&
        epoch == _epoch &&
        identical(controller.acceptedChange, accepted);
    setState(() {
      _reading = true;
      _error = null;
      _confirmed = false;
    });
    try {
      final result = await controller.inspectBuildProcessing(accepted);
      if (current()) {
        setState(() => _processing = result);
      }
    } catch (error) {
      if (current()) {
        setState(() {
          _processing = null;
          _error = _failure(error);
        });
      }
    } finally {
      if (mounted &&
          identical(controller, widget.controller) &&
          epoch == _epoch) {
        setState(() => _reading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final controller = widget.controller,
          review = _review,
          build = _build,
          accepted = controller.acceptedChange;
      final processing =
          accepted != null &&
              _processing != null &&
              privateActionSame(
                _processing!.acceptance,
                accepted.raw['acceptance'],
              )
          ? _processing
          : null;
      if (!_current) {
        return const Center(
          child: Text('Unlock and sign in to review private Memory actions.'),
        );
      }
      final eligible = review?.eligible == true || build?.eligible == true;
      final canSubmit =
          _supported &&
          eligible &&
          _confirmed &&
          !_reading &&
          !_saving &&
          _error == null &&
          controller.supportsChange(_change) &&
          controller.pendingChange == null &&
          !controller.changing;
      return ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(
            'Private Memory actions',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const Text(
            'Review a complete current plan before each action. A saved acceptance is evidence of that action; current Memory and processing status are read separately.',
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final item in const {
                'maintenance': 'Maintenance',
                'graph': 'Rebuild private graph',
                'build': 'Build source maps',
              }.entries)
                ChoiceChip(
                  label: Text(item.value),
                  selected: _kind == item.key,
                  onSelected: _saving ? null : (_) => _select(item.key),
                ),
            ],
          ),
          const SizedBox(height: 12),
          if (!_supported)
            const Text(
              'This action is unavailable for this account or app version. Check account access or update the app.',
            ),
          if (_kind == 'maintenance')
            const Text(
              'Maintenance can reversibly archive exact duplicates and expired records, and create promotion reviews. Pinned records are protected. Only private Memory already authorized for maintenance is included; permissions are not expanded.',
            ),
          if (_kind == 'graph')
            const Text(
              'Rebuild replaces only your private graph from the complete eligible Memory and trace inventory. Sources must be active, unarchived and currently valid. This does not change other owners’ graphs.',
            ),
          if (_kind == 'build') ...[
            const Text(
              'Build source maps for one current document. This uses the configured model and may incur provider charges. Generated claims remain unconfirmed until you separately review them in Source maps. Unknown provider work will be held without an automatic retry.',
            ),
            ExpansionTile(
              title: const Text('Choose a loaded source document'),
              children: [
                for (final document
                    in controller.state?.knowledge ?? const <KnowledgeItem>[])
                  ListTile(
                    title: Text(document.title),
                    subtitle: Text(document.id),
                    onTap: _saving ? null : () => _selectDocument(document.id),
                  ),
                const Padding(
                  padding: EdgeInsets.all(12),
                  child: Text(
                    'Only the loaded catalogue is shown. You can also inspect an exact document ID below. Eligibility is checked by the current source read.',
                  ),
                ),
              ],
            ),
            TextField(
              controller: _document,
              enabled: !_saving,
              decoration: const InputDecoration(
                labelText: 'Exact source document ID',
              ),
              onChanged: (_) => setState(_reset),
            ),
          ],
          const SizedBox(height: 12),
          OutlinedButton(
            onPressed: _supported && !_reading && !_saving ? _read : null,
            child: Text(
              _reading ? 'Reading current plan…' : 'Review current plan',
            ),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Text(_error!),
            ),
          if (review != null) ...[
            if (review.kind == 'maintenance')
              Text(
                '${review.review['excludedMemoryCount']} private records excluded from maintenance.',
              ),
            if (!review.eligible)
              Text(
                'Action unavailable: ${review.review['reason']}. No action has been submitted.',
              ),
            if (review.pin != null) ...[
              if (review.kind == 'maintenance')
                Text(
                  '${review.pin!['eligibleMemoryCount']} eligible private Memory records · complete reviewed plan',
                )
              else
                Text(
                  '${review.pin!['memoryCount']} private Memory records and ${review.pin!['traceCount']} private traces · complete reviewed inventory',
                ),
              _OperationDetails(
                value: review.pin!,
                title: 'Exact reviewed plan and policy',
              ),
            ],
          ],
          if (build != null) ...[
            Text(
              build.review['title'] as String,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            SelectableText(
              'Document: ${build.id}\nSource revision: ${build.pin['sourceRevisionId']}\nRetention: ${build.pin['retentionExpiresAt'] ?? 'no expiry reported'}',
            ),
            Text(
              '${build.pin['batchCount']} total batches · ${build.pin['existingReviewCount']} existing source maps available for reuse',
            ),
            Text(
              'Provider: ${(build.review['model'] as Map)['provider'] ?? 'unavailable'} · model: ${(build.review['model'] as Map)['model'] ?? 'unavailable'}',
            ),
            if (!build.eligible)
              Text(
                'Build unavailable: ${build.review['reason']}. No provider action has been submitted.',
              ),
            _OperationDetails(
              value: build.pin,
              title: 'Exact source, retention and build plan',
            ),
          ],
          if (eligible) ...[
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              value: _confirmed,
              onChanged: _saving || _reading
                  ? null
                  : (value) => setState(() => _confirmed = value ?? false),
              title: Text(
                _kind == 'build'
                    ? 'I reviewed this source and authorize this model build, including possible provider charges.'
                    : 'I reviewed the complete private inventory and authorize this action.',
              ),
            ),
            FilledButton(
              onPressed: canSubmit ? _submit : null,
              child: Text(
                _saving
                    ? 'Saving reviewed action…'
                    : _kind == 'build'
                    ? 'Confirm source-map build'
                    : _kind == 'graph'
                    ? 'Confirm private graph rebuild'
                    : 'Confirm private maintenance',
              ),
            ),
          ],
          MemoryChangeStatus(controller: controller),
          if (accepted?.submission.kind == MemoryChange.cognitionBuild) ...[
            OutlinedButton(
              onPressed: _reading || _saving
                  ? null
                  : () => _readProcessing(accepted!),
              child: const Text('Read accepted build progress'),
            ),
            _OperationDetails(
              value: processing?.processing ?? accepted!.raw['processing'],
              title: processing == null
                  ? 'Processing at receipt time'
                  : 'Latest verified processing read',
              expanded: true,
            ),
            const Text(
              'Read generated review IDs in Source maps to confirm or dismiss each candidate. Build completion alone does not accept any claim.',
            ),
          ],
          if (accepted != null &&
              const {
                MemoryChange.maintenance,
                MemoryChange.graphRebuild,
              }.contains(accepted.submission.kind))
            _OperationDetails(
              value: (accepted.raw['acceptance'] as Map)['result'],
              title: 'Saved action report',
              expanded: true,
            ),
        ],
      );
    },
  );
}

class _OperationDetails extends StatelessWidget {
  const _OperationDetails({
    required this.value,
    required this.title,
    this.expanded = false,
  });
  final Object? value;
  final String title;
  final bool expanded;
  @override
  Widget build(BuildContext context) {
    final data = value;
    if (data is Map) {
      return ExpansionTile(
        title: Text(title),
        initiallyExpanded: expanded,
        children: [
          for (final item in data.entries)
            _OperationDetails(value: item.value, title: '${item.key}'),
        ],
      );
    }
    if (data is List) {
      return ExpansionTile(
        title: Text('$title · ${data.length}'),
        children: [
          for (final item in data)
            _OperationDetails(value: item, title: 'Review'),
        ],
      );
    }
    return Align(
      alignment: Alignment.centerLeft,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: SelectableText('$title: ${data ?? 'unavailable'}'),
      ),
    );
  }
}
