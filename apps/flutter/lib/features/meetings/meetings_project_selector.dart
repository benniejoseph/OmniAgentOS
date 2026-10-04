import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../projects/projects.dart';
import '../projects/projects_providers.dart';
import 'meetings_action_controller.dart';
import 'meetings_validation.dart';
import 'meetings_widgets.dart';

class MeetingProjectChoice {
  const MeetingProjectChoice(this.id, this.title);
  final String id, title;
}

typedef MeetingProjectLoader = Future<List<MeetingProjectChoice>> Function(
  CancelToken cancel,
);

class MeetingProjectSelector extends ConsumerWidget {
  const MeetingProjectSelector({
    super.key,
    required this.actions,
    required this.selected,
    required this.enabled,
    required this.stillCurrent,
    required this.onChanged,
    this.loader,
  });
  final MeetingActionController actions;
  final String? selected;
  final bool enabled;
  final bool Function() stillCurrent;
  final ValueChanged<String?> onChanged;
  final MeetingProjectLoader? loader;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final injected = loader;
    if (injected != null) {
      return _ProjectField(
        key: ValueKey((injected, actions)),
        actions: actions,
        selected: selected,
        enabled: enabled,
        stillCurrent: stillCurrent,
        onChanged: onChanged,
        load: injected,
      );
    }
    final repository = ref.watch(projectsRepositoryProvider);
    return _ProjectField(
      key: ValueKey((repository, actions)),
      actions: actions,
      selected: selected,
      enabled: enabled,
      stillCurrent: stillCurrent,
      onChanged: onChanged,
      load: (cancel) async {
        meetingRequire(
          repository is FreshProjectsRepository,
          'Fresh project choices are unavailable.',
        );
        final owner = actions.owner;
        meetingRequire(owner != null && actions.available);
        final rows = await (repository as FreshProjectsRepository).listFresh(
          cancel,
        );
        meetingRequire(
          rows.length <= 80 &&
              rows.every((row) => row.tenantId == owner!.tenantId),
        );
        return rows
            .map((row) => MeetingProjectChoice(row.id, row.title))
            .toList();
      },
    );
  }
}

class _ProjectField extends StatefulWidget {
  const _ProjectField({
    super.key,
    required this.actions,
    required this.selected,
    required this.enabled,
    required this.stillCurrent,
    required this.onChanged,
    required this.load,
  });
  final MeetingActionController actions;
  final String? selected;
  final bool enabled;
  final bool Function() stillCurrent;
  final ValueChanged<String?> onChanged;
  final MeetingProjectLoader load;
  @override
  State<_ProjectField> createState() => _ProjectFieldState();
}

class _ProjectFieldState extends State<_ProjectField> {
  List<MeetingProjectChoice> choices = const [];
  CancelToken? request;
  bool loading = true;
  String? error;
  late final String? ownerKey;
  late final int generation;
  @override
  void initState() {
    super.initState();
    ownerKey = widget.actions.owner?.key;
    generation = widget.actions.repository.access.generation;
    widget.actions.addListener(_authorityChanged);
    scheduleMicrotask(_load);
  }

  bool get _current =>
      mounted &&
      widget.actions.available &&
      widget.stillCurrent() &&
      widget.actions.owner?.key == ownerKey &&
      widget.actions.repository.access.generation == generation;
  void _authorityChanged() {
    if (mounted && !_current) {
      request?.cancel('Meeting project selection scope changed.');
      setState(() {
        choices = const [];
        loading = false;
        error = null;
      });
    }
  }

  Future<void> _load() async {
    if (!_current) {
      return;
    }
    request?.cancel('Project choices refreshed.');
    final token = CancelToken();
    request = token;
    setState(() {
      loading = true;
      error = null;
      choices = const [];
    });
    try {
      final rows = await widget.load(token);
      meetingRequire(rows.length <= 80);
      for (final row in rows) {
        meetingId(row.id, max: 240);
        meetingText(row.title, max: 240);
      }
      meetingUnique(rows.map((row) => row.id));
      if (_current && identical(request, token) && !token.isCancelled) {
        setState(() {
          choices = List.unmodifiable(rows);
          loading = false;
        });
      }
    } catch (_) {
      if (_current && identical(request, token) && !token.isCancelled) {
        setState(() {
          loading = false;
          error = 'Project choices could not be refreshed. The saved project reference is retained.';
        });
      }
    }
  }

  @override
  void dispose() {
    widget.actions.removeListener(_authorityChanged);
    request?.cancel('Meeting project selector closed.');
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!_current) {
      return const Text(
        'Project choices are hidden until the current Meeting scope is restored.',
      );
    }
    final retained =
        widget.selected != null &&
        !choices.any((row) => row.id == widget.selected);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DropdownButtonFormField<String>(
          key: ValueKey('meeting-project:${widget.selected}'),
          initialValue: widget.selected ?? '',
          isExpanded: true,
          decoration: const InputDecoration(labelText: 'Project'),
          items: [
            const DropdownMenuItem(value: '', child: Text('No project')),
            if (retained)
              DropdownMenuItem(
                value: widget.selected,
                child: Text(
                  'Saved project · ${widget.selected}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            for (final row in choices)
              DropdownMenuItem(
                value: row.id,
                child: Tooltip(
                  message: row.title,
                  child: Text(
                    row.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ),
          ],
          onChanged: widget.enabled && !loading && _current
              ? (value) {
                  widget.onChanged(value == '' ? null : value);
                }
              : null,
        ),
        if (loading) const Text('Checking up to 80 readable projects…'),
        if (error != null) MeetingNotice(error!, error: true),
        const Text(
          'The selected project must belong to this Meeting workspace. Its availability is checked again on save.',
        ),
        TextButton(
          key: const Key('meeting-refresh-projects'),
          onPressed: !loading && _current ? _load : null,
          child: const Text('Refresh project choices'),
        ),
      ],
    );
  }
}
