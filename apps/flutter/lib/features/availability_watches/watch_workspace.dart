import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../app/mobile/mobile_page_scaffold.dart';
import '../../app/platform/macos_presentation.dart';
import '../../core/network/native_workspace_access.dart';
import 'watch_controller.dart';
import 'watch_desktop_alerts.dart';
import 'watch_models.dart';
import 'watch_repository.dart';

class NativeAvailabilityWatchesPage extends StatelessWidget {
  const NativeAvailabilityWatchesPage({super.key, this.id});
  final String? id;
  @override
  Widget build(BuildContext context) => NativePrivateWorkspace(
    builder: (access) => _WatchWorkspace(
      key: ValueKey((access.identity, id)),
      access: access,
      id: id,
    ),
  );
}

class _WatchWorkspace extends StatefulWidget {
  const _WatchWorkspace({super.key, required this.access, this.id});
  final NativeWorkspaceAccess access;
  final String? id;
  @override
  State<_WatchWorkspace> createState() => _WatchWorkspaceState();
}

class _WatchWorkspaceState extends State<_WatchWorkspace> {
  late final controller = WatchController(WatchRepository(widget.access));
  Timer? _refresh;
  bool _creating = false;
  @override
  void initState() {
    super.initState();
    unawaited(controller.load(widget.id));
    _refresh = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted &&
          TickerMode.valuesOf(context).enabled &&
          WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed &&
          !controller.busy) {
        unawaited(controller.load(widget.id));
      }
    });
  }

  @override
  void dispose() {
    _refresh?.cancel();
    controller.dispose();
    super.dispose();
  }

  Future<void> _open(String url) async {
    try {
      if (!widget.access.current) return;
      if (!await launchUrl(
        watchPublicUrl(url),
        mode: LaunchMode.externalApplication,
      )) {
        throw StateError('Unavailable');
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('The booking page could not be opened.'),
          ),
        );
      }
    }
  }

  Future<void> _created(Future<AvailabilityWatch> Function() action) async {
    final saved = await controller.mutate(action);
    if (saved != null && mounted && controller.current) {
      setState(() => _creating = false);
      context.go('/watches/${Uri.encodeComponent(saved.id)}');
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      final detail = controller.selected;
      final actions = <Widget>[
        IconButton(
          tooltip: 'Refresh watches',
          onPressed: controller.loading || controller.busy
              ? null
              : () => controller.load(widget.id),
          icon: const Icon(Icons.refresh),
        ),
      ];
      final newButton =
          widget.id == null && widget.access.canManage && !_creating
          ? FilledButton.icon(
              onPressed: controller.repository.hasPending
                  ? null
                  : () => setState(() => _creating = true),
              icon: const Icon(Icons.add),
              label: const Text('New watch'),
            )
          : null;
      final content = ListView(
        padding: EdgeInsets.all(usesMacosPresentation() ? 24 : 16),
        children: [
          const WatchDesktopAlertSettings(),
          if (widget.id != null)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: () => context.go('/watches'),
                icon: const Icon(Icons.arrow_back),
                label: const Text('All watches'),
              ),
            ),
          if (controller.loading) const LinearProgressIndicator(),
          if (controller.error != null)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Semantics(
                liveRegion: true,
                child: Text(
                  '${controller.error}${controller.loaded ? ' Previously loaded details may be stale.' : ''}',
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            ),
          if (controller.repository.hasPending)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'The save result is not confirmed. Retry the same request to recover its saved result; do not create a duplicate.',
                  ),
                  const SizedBox(height: 8),
                  OutlinedButton(
                    onPressed: controller.busy
                        ? null
                        : () async {
                            if (widget.id == null) {
                              await _created(controller.repository.retry);
                            } else {
                              await controller.mutate(
                                controller.repository.retry,
                              );
                              await controller.load(widget.id);
                            }
                          },
                    child: Text(
                      controller.busy ? 'Saving…' : 'Retry saved request',
                    ),
                  ),
                ],
              ),
            ),
          if (_creating)
            WatchCreateForm(
              busy: controller.busy || controller.repository.hasPending,
              onCancel: controller.repository.hasPending
                  ? null
                  : () => setState(() => _creating = false),
              onSubmit: (value) =>
                  _created(() => controller.repository.create(value)),
            ),
          if (widget.id == null && !_creating) ...[
            const Text(
              'Asael checks the selected cinema on the server until a matching booking opens, the watch expires, or you stop it. Closing this app does not stop checks.',
            ),
            const SizedBox(height: 16),
            if (controller.loaded && controller.watches.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 36),
                child: Text(
                  'No watches yet. Add a cinema and date, or ask ATLAS to set one up.',
                ),
              ),
            for (final watch in controller.watches) ...[
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(
                  watch.film,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                subtitle: Text(
                  '${watch.cinema}\n${watch.date} · ${watch.statusLabel}${watch.raw['nextCheckAt'] == null ? '' : ' · next ${_time(watch.raw['nextCheckAt'])}'}',
                ),
                isThreeLine: true,
                trailing: const Icon(Icons.chevron_right),
                onTap: () =>
                    context.go('/watches/${Uri.encodeComponent(watch.id)}'),
              ),
              const Divider(height: 1),
            ],
            if (controller.hasMore)
              const Padding(
                padding: EdgeInsets.only(top: 16),
                child: Text(
                  'The 40 most recent watches are shown. Older watches remain available through their direct links.',
                ),
              ),
          ],
          if (widget.id != null && detail != null)
            _WatchDetail(
              watch: detail,
              checks: controller.checks,
              readiness: controller.readiness,
              hasMore: controller.hasMore,
              canStop:
                  widget.access.canManage &&
                  !controller.loading &&
                  !controller.busy &&
                  !controller.repository.hasPending &&
                  controller.error == null,
              onStop: () async {
                await controller.mutate(
                  () => controller.repository.stop(detail),
                );
                await controller.load(widget.id);
              },
              onOpen: _open,
            ),
          if (widget.id != null &&
              !controller.loading &&
              detail == null &&
              controller.error == null)
            const Text('This watch is unavailable.'),
        ],
      );
      if (usesMacosPresentation()) {
        return MacosPageScaffold(
          title: widget.id == null ? 'Watches' : 'Availability watch',
          description:
              'Booking availability, scheduled checks and delivery evidence.',
          icon: Icons.visibility_outlined,
          actions: actions,
          primaryAction: newButton,
          maxContentWidth: 1200,
          body: content,
        );
      }
      return Scaffold(
        body: SafeArea(
          child: Column(
            children: [
              MobilePageHeader(
                title: widget.id == null ? 'Watches' : 'Availability watch',
                subtitle: 'Bookings you want Asael to keep checking',
                actions: [...actions, ?newButton],
              ),
              Expanded(child: content),
            ],
          ),
        ),
      );
    },
  );
}

class _WatchDetail extends StatelessWidget {
  const _WatchDetail({
    required this.watch,
    required this.checks,
    this.readiness,
    required this.hasMore,
    required this.canStop,
    required this.onStop,
    required this.onOpen,
  });
  final AvailabilityWatch watch;
  final List<WatchJson> checks;
  final WatchJson? readiness;
  final bool hasMore, canStop;
  final VoidCallback onStop;
  final ValueChanged<String> onOpen;
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(watch.film, style: theme.textTheme.headlineSmall),
        const SizedBox(height: 8),
        Text(watch.cinema, style: theme.textTheme.titleMedium),
        const SizedBox(height: 12),
        MobileStatusPill(
          label: watch.statusLabel,
          icon: watch.state == 'fulfilled'
              ? Icons.check_circle_outline
              : Icons.schedule,
        ),
        const SizedBox(height: 20),
        Wrap(
          spacing: 40,
          runSpacing: 16,
          children: [
            _fact(
              'Date and seats',
              '${watch.date} · ${watch.target['seatClass'] == 'gold' ? 'Gold' : 'Any class'}',
            ),
            _fact(
              'Language and time',
              '${watch.target['language'] ?? 'Any language'} · ${watch.target['earliestTime'] ?? '00:00'}–${watch.target['latestTime'] ?? '23:59'} IST',
            ),
            _fact(
              'Check interval',
              'Every ${watch.interval} minute${watch.interval == 1 ? '' : 's'}',
            ),
            _fact('Last attempted', _time(watch.raw['lastCheckedAt'])),
            _fact('Last successful', _time(watch.raw['lastSuccessfulAt'])),
            _fact(
              'Next check',
              watch.raw['nextCheckAt'] == null
                  ? (const {'active', 'degraded'}.contains(watch.state)
                        ? 'Check queued or running'
                        : 'Checks finished')
                  : _time(watch.raw['nextCheckAt']),
            ),
            _fact('Expires', _time(watch.config['expiresAt'])),
            _fact('Checks used', '${watch.checksUsed} of ${watch.maxChecks}'),
          ],
        ),
        const SizedBox(height: 16),
        if (watch.lastError != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: Text(
              '${watch.lastError!['message']} Last failure ${_time(watch.lastError!['at'])}.',
              style: TextStyle(color: theme.colorScheme.error),
            ),
          ),
        if (watch.raw['lastObservation'] != null && watch.matches.isEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: Text(
              watchMap(watch.raw['lastObservation'])['outcome'] == 'sold_out'
                  ? 'Matching sessions were found, but no bookable seats were reported.'
                  : 'The last successful check did not list a matching bookable session.',
            ),
          ),
        Wrap(
          spacing: 12,
          runSpacing: 8,
          children: [
            OutlinedButton.icon(
              onPressed: () =>
                  onOpen('${watch.source['sourceUrl']}?fromdate=${watch.date}'),
              icon: const Icon(Icons.open_in_browser),
              label: const Text('Open the dated District listing'),
            ),
            if (watch.canStop)
              OutlinedButton(
                onPressed: canStop ? onStop : null,
                child: const Text('Stop watch and pending alerts'),
              ),
          ],
        ),
        const SizedBox(height: 24),
        Text('Where and how Asael checks', style: theme.textTheme.titleLarge),
        const SizedBox(height: 8),
        Text(
          readiness?['method'] as String? ?? 'Asael reads the public District listing for this exact cinema and date, then matches your saved conditions.',
        ),
        const SizedBox(height: 8),
        Text(
          readiness?['schedule'] as String? ?? 'Checks are periodic. Scheduler and source delays can extend the displayed interval.',
        ),
        const SizedBox(height: 8),
        const Text(
          "Only District is checked. BookMyShow and PVR's own website are not checked. A failed read means availability is unknown.",
        ),
        const SizedBox(height: 24),
        Text('Alerts', style: theme.textTheme.titleLarge),
        const SizedBox(height: 8),
        Text(_alertCopy(watch)),
        const SizedBox(height: 8),
        const Text(
          'Booking openings bypass Asael quiet hours. Account notifications-off and device permissions still apply. Provider acceptance does not confirm a device received the alert.',
        ),
        if (usesMacosPresentation())
          const Padding(
            padding: EdgeInsets.only(top: 8),
            child: Text(
              'The owner-only Mac build cannot receive Apple push notifications. Updates remain in Inbox; use an eligible phone or Apple-signed Mac build for alerts while the app is closed.',
            ),
          ),
        if (readiness != null) ...[
          const SizedBox(height: 12),
          Text(_readinessCopy(readiness!)),
        ] else
          const Text(
            'Current alert readiness has not been verified. Refresh to retry.',
          ),
        if (watch.delivery != null)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Text(_transportCopy(watch.delivery!)),
          ),
        if (watch.matches.isNotEmpty) ...[
          const SizedBox(height: 24),
          Text('Bookable sessions found', style: theme.textTheme.titleLarge),
          const SizedBox(height: 8),
          const Text(
            'Seats and prices can change before checkout. Checks have stopped after the first opening.',
          ),
          for (final match in watch.matches) ...[
            const Divider(height: 24),
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text('${match['localTime']} IST · ${match['movieTitle']}'),
              subtitle: Text(
                '${match['language']} · ${match['seatClass']} · ${match['availableSeats']} seats${match['price'] == null ? '' : ' · ₹${match['price']}'}',
              ),
              trailing: OutlinedButton(
                onPressed: () => onOpen(match['bookingUrl'] as String),
                child: const Text('Book'),
              ),
            ),
          ],
        ],
        const SizedBox(height: 24),
        ExpansionTile(
          tilePadding: EdgeInsets.zero,
          title: const Text('Recent checks'),
          children: [
            if (checks.isEmpty)
              const ListTile(title: Text('No check has completed yet.')),
            for (final check in checks)
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(
                  '${_time(check['scheduledFor'])} · ${_checkLabel(check)}',
                ),
                subtitle: check['error'] == null
                    ? null
                    : Text(
                        watchMap(check['error'])['message']?.toString() ??
                            'The source could not be read.',
                      ),
              ),
            if (hasMore)
              const ListTile(
                title: Text('Older checks are outside this recent window.'),
              ),
          ],
        ),
      ],
    );
  }

  Widget _fact(String label, String value) => SizedBox(
    width: 225,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label),
        const SizedBox(height: 4),
        Text(value, style: const TextStyle(fontWeight: FontWeight.w600)),
      ],
    ),
  );
}

String _alertCopy(AvailabilityWatch watch) =>
    switch (watch.notification?['state']) {
      'held' => 'The opening was detected. Your alert is held until delivery settings allow it.',
      'disabled' => 'The opening was detected, but notifications are disabled or their settings are unavailable.',
      'recorded' => 'The opening alert is saved in your Inbox.',
      'canceled' => 'Pending alerts were canceled when this watch stopped.',
      'expired' =>
        'The watch expired before its pending alert could be recorded.',
      'pending' => 'The opening was detected and its alert is pending.',
      _ => 'Asael will alert you once when it detects a matching booking.',
    };
String _transportCopy(WatchJson value) =>
    '${value['eligibleDevices'] ?? 0} eligible devices · ${value['queued'] ?? 0} queued · ${value['running'] ?? 0} sending · ${value['providerAccepted'] ?? 0} accepted by provider · ${value['received'] ?? 0} received on device · ${value['opened'] ?? 0} opened · ${value['failed'] ?? 0} failed';
String _checkLabel(WatchJson value) {
  if (value['state'] != 'completed') {
    return value['state']?.toString() ?? 'Unknown';
  }
  return switch (value['observation'] == null
      ? null
      : watchMap(value['observation'])['outcome']) {
    'available' => 'Booking availability found',
    'sold_out' => 'Matching sessions sold out',
    'not_listed' => 'No matching session listed',
    _ => 'Completed',
  };
}

String _time(Object? value) {
  final parsed = watchTime(value);
  if (parsed == null) return 'Not yet';
  final india = parsed.add(const Duration(hours: 5, minutes: 30));
  String two(int number) => number.toString().padLeft(2, '0');
  return '${india.day}/${india.month}/${india.year} ${two(india.hour)}:${two(india.minute)} IST';
}

class WatchCreateForm extends StatefulWidget {
  const WatchCreateForm({
    super.key,
    required this.busy,
    required this.onSubmit,
    this.onCancel,
  });
  final bool busy;
  final ValueChanged<WatchJson> onSubmit;
  final VoidCallback? onCancel;
  @override
  State<WatchCreateForm> createState() => _WatchCreateFormState();
}

class _WatchCreateFormState extends State<WatchCreateForm> {
  final _form = GlobalKey<FormState>();
  final _url = TextEditingController(),
      _cinema = TextEditingController(),
      _film = TextEditingController(),
      _language = TextEditingController();
  final _earliest = TextEditingController(), _latest = TextEditingController();
  late DateTime _date = _nextMonday();
  String _seatClass = 'gold';
  int _interval = 2;
  @override
  void dispose() {
    for (final value in [_url, _cinema, _film, _language, _earliest, _latest]) {
      value.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Form(
    key: _form,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'New availability watch',
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 8),
        const Text(
          'Choose a public District cinema page and the date you want. This watch checks that source only and stops at the first matching opening or at the end of the selected date.',
        ),
        const SizedBox(height: 16),
        TextFormField(
          controller: _url,
          enabled: !widget.busy,
          maxLength: 500,
          decoration: const InputDecoration(
            labelText: 'District cinema page',
            hintText: 'https://www.district.in/movies/…-CD123',
          ),
          validator: (value) {
            try {
              final url = watchPublicUrl(value?.trim() ?? '');
              if (url.hasQuery ||
                  !RegExp(r'^/movies/[a-z0-9-]+-CD[1-9]\d{0,11}$')
                      .hasMatch(url.path)) {
                return 'Use the cinema page without a date or other query.';
              }
            } catch (_) {
              return 'Paste the public District cinema page.';
            }
            return null;
          },
        ),
        TextFormField(
          controller: _cinema,
          enabled: !widget.busy,
          maxLength: 180,
          decoration: const InputDecoration(
            labelText: 'Cinema name',
            hintText: 'PVR VR, Whitefield Road, Bengaluru',
          ),
          validator: (value) => value?.trim().isNotEmpty == true
              ? null
              : 'Enter the cinema name.',
        ),
        TextFormField(
          controller: _film,
          enabled: !widget.busy,
          maxLength: 180,
          decoration: const InputDecoration(
            labelText: 'Movie title',
            helperText:
                'Leave blank to watch any movie matching these conditions.',
          ),
        ),
        Wrap(
          spacing: 16,
          runSpacing: 16,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            OutlinedButton.icon(
              onPressed: widget.busy
                  ? null
                  : () async {
                      final now = DateTime.now().toUtc().add(
                        const Duration(hours: 5, minutes: 30),
                      );
                      final first = DateTime(now.year, now.month, now.day);
                      final chosen = await showDatePicker(
                        context: context,
                        initialDate: _date.isBefore(first) ? first : _date,
                        firstDate: first,
                        lastDate: first.add(const Duration(days: 31)),
                      );
                      if (chosen != null && mounted) {
                        setState(() => _date = chosen);
                      }
                    },
              icon: const Icon(Icons.calendar_today_outlined),
              label: Text('${_date.day}/${_date.month}/${_date.year}'),
            ),
            SizedBox(
              width: 180,
              child: DropdownButtonFormField<String>(
                initialValue: _seatClass,
                decoration: const InputDecoration(labelText: 'Seat class'),
                items: const [
                  DropdownMenuItem(value: 'gold', child: Text('Gold')),
                  DropdownMenuItem(value: 'any', child: Text('Any class')),
                ],
                onChanged: widget.busy
                    ? null
                    : (value) => setState(() => _seatClass = value!),
              ),
            ),
            SizedBox(
              width: 190,
              child: DropdownButtonFormField<int>(
                initialValue: _interval,
                decoration: const InputDecoration(labelText: 'Check interval'),
                items: [1, 2, 5, 10, 15, 30, 60]
                    .map(
                      (value) => DropdownMenuItem(
                        value: value,
                        child: Text('$value minute${value == 1 ? '' : 's'}'),
                      ),
                    )
                    .toList(),
                onChanged: widget.busy
                    ? null
                    : (value) => setState(() => _interval = value!),
              ),
            ),
          ],
        ),
        const SizedBox(height: 16),
        TextFormField(
          controller: _language,
          enabled: !widget.busy,
          maxLength: 60,
          decoration: const InputDecoration(labelText: 'Language (optional)'),
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 16,
          runSpacing: 16,
          children: [
            SizedBox(
              width: 220,
              child: TextFormField(
                controller: _earliest,
                enabled: !widget.busy,
                decoration: const InputDecoration(
                  labelText: 'Earliest showtime (IST)',
                  hintText: 'HH:mm, optional',
                ),
                validator: _validateTime,
              ),
            ),
            SizedBox(
              width: 220,
              child: TextFormField(
                controller: _latest,
                enabled: !widget.busy,
                decoration: const InputDecoration(
                  labelText: 'Latest showtime (IST)',
                  hintText: '12:00 for noon',
                ),
                validator: (value) {
                  final error = _validateTime(value);
                  if (error != null) return error;
                  return _earliest.text.trim().isNotEmpty &&
                          (value?.trim().isNotEmpty ?? false) &&
                          _earliest.text.trim().compareTo(value!.trim()) > 0
                      ? 'Use a time after the earliest showtime.'
                      : null;
                },
              ),
            ),
          ],
        ),
        const SizedBox(height: 16),
        const Text(
          'Booking openings bypass Asael quiet hours; account notifications-off and device permissions still apply. Use an eligible phone or enable app-open Mac alerts to receive device notifications. Booking and payment remain yours to complete.',
        ),
        const SizedBox(height: 20),
        Wrap(
          spacing: 12,
          children: [
            FilledButton(
              onPressed: widget.busy ? null : _submit,
              child: Text(widget.busy ? 'Saving…' : 'Start watch'),
            ),
            TextButton(
              onPressed: widget.busy ? null : widget.onCancel,
              child: const Text('Cancel'),
            ),
          ],
        ),
      ],
    ),
  );
  String? _validateTime(String? value) =>
      value?.trim().isNotEmpty == true &&
          !RegExp(r'^(?:[01]\d|2[0-3]):[0-5]\d$').hasMatch(value!.trim())
      ? 'Use a 24-hour time such as 12:00.'
      : null;
  void _submit() {
    if (!_form.currentState!.validate()) return;
    final url = watchPublicUrl(_url.text.trim());
    String? optional(TextEditingController value) =>
        value.text.trim().isEmpty ? null : value.text.trim();
    widget.onSubmit({
      'source': {
        'provider': 'district',
        'cinemaId': RegExp(r'-CD(\d+)$').firstMatch(url.path)!.group(1),
        'cinemaName': _cinema.text.trim(),
        'sourceUrl': url.toString(),
      },
      'target': {
        'date':
            '${_date.year}-${_date.month.toString().padLeft(2, '0')}-${_date.day.toString().padLeft(2, '0')}',
        'timezone': 'Asia/Kolkata',
        'movieTitle': optional(_film),
        'language': optional(_language),
        'seatClass': _seatClass,
        'earliestTime': optional(_earliest),
        'latestTime': optional(_latest),
      },
      'intervalMinutes': _interval,
    });
  }
}

DateTime _nextMonday() {
  final now = DateTime.now().toUtc().add(const Duration(hours: 5, minutes: 30));
  final today = DateTime(now.year, now.month, now.day);
  final offset = (DateTime.monday - today.weekday + 7) % 7;
  return today.add(Duration(days: offset == 0 ? 7 : offset));
}

String _readinessCopy(WatchJson value) {
  final android = watchMap(value['android']),
      browser = watchMap(value['browser']);
  return 'Shared app and web Inbox: ${value['inbox']}. '
      'Android: ${android['eligible']} eligible device(s)${android['needsUpdate'] == 0 ? '' : '; an app update is needed'}. '
      'Browser: ${browser['eligible']} eligible registration(s). '
      'Browser delivery: ${browser['queued']} queued, ${browser['accepted']} accepted, ${browser['received']} displayed, ${browser['opened']} opened, ${browser['failed']} failed. '
      '${android['eligible'] == 0 ? 'Open the current Android app, sign in and allow notifications for phone alerts. ' : ''}'
      'Enable browser alerts from Watches on the Asael website.';
}
