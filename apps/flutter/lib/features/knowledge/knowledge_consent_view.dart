import 'package:flutter/material.dart';

import '../../core/network/api_exception.dart';
import 'knowledge.dart';
import 'knowledge_consent_contracts.dart';
import 'knowledge_mutations.dart';
import 'knowledge_mutation_widgets.dart';

class KnowledgePersonalRecall extends StatefulWidget {
  const KnowledgePersonalRecall({
    super.key,
    required this.controller,
    this.active = true,
  });
  final KnowledgeController controller;
  final bool active;
  @override
  State<KnowledgePersonalRecall> createState() =>
      _KnowledgePersonalRecallState();
}

class _KnowledgePersonalRecallState extends State<KnowledgePersonalRecall>
    with WidgetsBindingObserver {
  MemoryConsentRead? _read;
  String? _error, _confirmation;
  bool _loading = false, _saving = false, _foreground = true;
  int _epoch = 0;
  bool get _current =>
      mounted && widget.active && _foreground && widget.controller.available;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    _load();
  }

  @override
  void didUpdateWidget(covariant KnowledgePersonalRecall oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, widget.controller) ||
        oldWidget.active != widget.active) {
      _reset();
      _load();
    }
  }

  void _reset() {
    _epoch++;
    _read = null;
    _error = _confirmation = null;
    _loading = _saving = false;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    setState(_reset);
    _load();
  }

  @override
  void dispose() {
    _epoch++;
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  String _failure(Object error) => error is FormatException
      ? error.message
      : error is ApiException &&
            const {401, 403, 404}.contains(error.statusCode)
      ? 'Personal recall consent is unavailable to this account. Any submitted decision remains held until its exact receipt can be read.'
      : 'The current personal recall setting could not be read. Retry the read. A saved decision receipt remains valid.';

  Future<void> _load() async {
    if (!_current || !widget.controller.consentAvailable) {
      return;
    }
    final controller = widget.controller, epoch = ++_epoch;
    bool current() =>
        _current && identical(controller, widget.controller) && epoch == _epoch;
    setState(() {
      _loading = true;
      _error = null;
      _confirmation = null;
    });
    try {
      final read = await controller.readConsent();
      if (current()) {
        setState(() => _read = read);
      }
    } catch (error) {
      if (current()) {
        setState(() {
          _error = _failure(error);
          if (error is ApiException &&
              const {401, 403, 404}.contains(error.statusCode)) {
            _read = null;
          }
        });
      }
    } finally {
      if (current()) {
        setState(() => _loading = false);
      }
    }
  }

  Future<void> _decide(MemoryConsentCurrent reviewed, String action) async {
    final controller = widget.controller, epoch = _epoch;
    bool current() =>
        _current &&
        identical(controller, widget.controller) &&
        epoch == _epoch &&
        identical(_read?.current, reviewed) &&
        !_loading &&
        _error == null &&
        _confirmation == action;
    if (!current() || _saving) {
      return;
    }
    setState(() => _saving = true);
    try {
      await controller.decideConsent(
        reviewed,
        action,
        isReviewCurrent: current,
      );
      if (current() && controller.pendingChange == null) {
        await _load();
      }
    } catch (error) {
      if (current()) {
        setState(() => _error = _failure(error));
      }
    } finally {
      if (mounted && identical(controller, widget.controller)) {
        setState(() => _saving = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final controller = widget.controller;
      if (!_current) {
        return const Center(
          child: Text('Unlock and sign in to view personal recall consent.'),
        );
      }
      if (!controller.consentAvailable) {
        return const Padding(
          padding: EdgeInsets.all(20),
          child: Text(
            'Personal recall consent is unavailable for this account or app version. Check account access or update the app, then reopen Personal recall.',
          ),
        );
      }
      final consent = _read?.current;
      final canDecide =
          consent?.token != null &&
          !_loading &&
          !_saving &&
          _error == null &&
          controller.supportsChange(MemoryChange.consent) &&
          controller.pendingChange == null &&
          !controller.changing;
      final action = consent?.active == true ? 'revoke' : 'activate';
      return ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            'Personal automatic recall',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 8),
          const Text(
            'Choose whether saved personal memory may be recalled when you select Personal automatic context for a request. This setting does not choose that context mode for you.',
          ),
          const SizedBox(height: 12),
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: OutlinedButton(
              onPressed: _loading || _saving ? null : _load,
              child: const Text('Refresh personal recall'),
            ),
          ),
          if (_loading)
            const Text(
              'Reading your current notice and personal recall setting…',
            ),
          if (_error != null) Semantics(liveRegion: true, child: Text(_error!)),
          if (consent == null && !_loading)
            const Text(
              'The current setting is unavailable. No enabled or disabled state is assumed.',
            ),
          MemoryChangeStatus(controller: controller),
          if (consent != null) ...[
            const SizedBox(height: 12),
            Semantics(
              liveRegion: true,
              child: Text(
                'Last verified read: personal automatic recall is ${consent.active ? 'on' : 'off'}.',
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
            if (controller.pendingChange?.kind == MemoryChange.consent)
              const Text(
                'A submitted decision is still unconfirmed. The setting above does not prove whether that request was accepted.',
              ),
            const SizedBox(height: 16),
            Text(
              'Current recall notice',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            SelectableText(consent.notice['text'] as String),
            const SizedBox(height: 12),
            ExpansionTile(
              title: const Text('Notice and consent details'),
              children: [
                Padding(
                  padding: const EdgeInsets.all(12),
                  child: SelectableText(
                    'Notice: ${consent.notice['contractId']} · version ${consent.notice['version']}\nNotice digest: ${consent.notice['sha256']}\nConsent generation: ${consent.generation}\nLifecycle revision: ${consent.raw['lifecycleRevision']}',
                  ),
                ),
              ],
            ),
            if (consent.token == null ||
                !controller.supportsChange(MemoryChange.consent))
              const Text(
                'You can read this notice and setting. Changing it requires current Memory write access and a fresh consent review.',
              ),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: OutlinedButton(
                onPressed: canDecide
                    ? () => setState(() => _confirmation = action)
                    : null,
                child: Text(
                  consent.active
                      ? 'Disable personal recall'
                      : 'Enable personal recall',
                ),
              ),
            ),
            if (_confirmation != null)
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        _confirmation == 'activate'
                            ? 'Enable personal automatic recall?'
                            : 'Disable personal automatic recall?',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 8),
                      Text(
                        _confirmation == 'activate'
                            ? 'Confirm the full notice above. Relevant saved personal memory may then be selected only for requests where you choose Personal automatic context.'
                            : 'Confirm turning personal automatic recall off. This does not delete your saved memories.',
                      ),
                      Wrap(
                        spacing: 12,
                        runSpacing: 8,
                        children: [
                          TextButton(
                            onPressed: _saving
                                ? null
                                : () => setState(() => _confirmation = null),
                            child: const Text('Cancel consent decision'),
                          ),
                          FilledButton(
                            onPressed: canDecide
                                ? () => _decide(consent, _confirmation!)
                                : null,
                            child: Text(
                              _confirmation == 'activate'
                                  ? 'Confirm enable personal recall'
                                  : 'Confirm disable personal recall',
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
          ],
        ],
      );
    },
  );
}
