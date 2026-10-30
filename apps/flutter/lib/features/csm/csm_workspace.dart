import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/mobile/mobile_flow_scaffold.dart';
import '../../app/mobile/mobile_page_scaffold.dart';
import '../../core/network/api_exception.dart';
import '../../core/network/native_workspace_access.dart';
import '../capture/library_view.dart';
import '../projects/project_workspaces.dart';
import '../projects/projects.dart';
import '../talk/talk.dart';
import 'csm_repository.dart';

class CsmDraftNotifier extends Notifier<TalkDraftHandoff?> {
  @override
  TalkDraftHandoff? build() {
    ref.watch(nativeWorkspaceAccessProvider);
    return null;
  }

  void stage(TalkDraftHandoff draft) {
    if (draft.authority.isCurrent()) state = draft;
  }

  void handled(String id) {
    if (state?.id == id) state = null;
  }
}

final csmDraftProvider = NotifierProvider<CsmDraftNotifier, TalkDraftHandoff?>(
  CsmDraftNotifier.new,
);

class MobileCsmWork extends StatelessWidget {
  const MobileCsmWork({
    super.key,
    required this.projects,
    required this.onOpen,
    this.onOpenResponsibilities,
  });
  final ProjectsController projects;
  final ValueChanged<Project> onOpen;
  final VoidCallback? onOpenResponsibilities;
  @override
  Widget build(BuildContext context) => NativePrivateWorkspace(
    ownNavigator: true,
    builder: (access) => _CsmWork(
      access: access,
      projects: projects,
      onOpen: onOpen,
      onOpenResponsibilities: onOpenResponsibilities,
    ),
  );
}

class _CsmWork extends StatefulWidget {
  const _CsmWork({
    required this.access,
    required this.projects,
    required this.onOpen,
    this.onOpenResponsibilities,
  });
  final NativeWorkspaceAccess access;
  final ProjectsController projects;
  final ValueChanged<Project> onOpen;
  final VoidCallback? onOpenResponsibilities;
  @override
  State<_CsmWork> createState() => _CsmWorkState();
}

class _CsmWorkState extends State<_CsmWork> {
  late final CsmRepository repository = CsmRepository(widget.access);
  List<CsmClient> clients = [];
  bool loading = true, truncated = false;
  bool _clientsRequested = false;
  String? error;
  String tab = 'projects';
  @override
  void initState() {
    super.initState();
    widget.projects.addListener(_projectsChanged);
  }

  void _projectsChanged() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.projects.removeListener(_projectsChanged);
    repository.dispose();
    super.dispose();
  }

  Future<void> load() async {
    if (!repository.current) return;
    setState(() {
      _clientsRequested = true;
      loading = true;
      error = null;
    });
    try {
      final data = await repository.clients();
      if (mounted && repository.current) {
        setState(() {
          clients = data.clients;
          truncated = data.truncated;
        });
      }
    } catch (_) {
      if (mounted && repository.current) {
        setState(
          () => error =
              'Your clients could not be loaded. Pull down to try again.',
        );
      }
    } finally {
      if (mounted && repository.current) setState(() => loading = false);
    }
  }

  Future<void> open(Project project) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => _CsmDetail(
          access: widget.access,
          project: project,
          onOpenTasks: () => widget.onOpen(project),
        ),
      ),
    );
    if (mounted && repository.current) unawaited(load());
  }

  Future<void> add() async {
    final result = await Navigator.of(context).push<Project>(
      MaterialPageRoute(
        builder: (_) =>
            _NewClient(access: widget.access, projects: widget.projects),
      ),
    );
    if (!mounted || !repository.current) return;
    if (result != null) await open(result);
    if (mounted && repository.current) unawaited(load());
  }

  @override
  Widget build(BuildContext context) => Column(
    children: [
      MobilePageHeader(
        title: 'Work',
        subtitle: 'Your projects, clients and next steps.',
        actions: [
          if (widget.onOpenResponsibilities != null)
            IconButton(
              onPressed: widget.onOpenResponsibilities,
              tooltip: 'Follow-ups',
              icon: const Icon(Icons.checklist_rounded),
            ),
        ],
      ),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20),
        child: MobileSegmentBar<String>(
          value: tab,
          items: const [
            (
              value: 'projects',
              label: 'Projects',
              icon: Icons.work_outline_rounded,
            ),
            (
              value: 'clients',
              label: 'Clients',
              icon: Icons.people_outline_rounded,
            ),
            (value: 'role', label: 'My role', icon: Icons.badge_outlined),
          ],
          onChanged: (value) {
            setState(() => tab = value);
            if (value == 'clients' && !_clientsRequested) unawaited(load());
          },
        ),
      ),
      const SizedBox(height: 12),
      Expanded(
        child: switch (tab) {
          'projects' => ProjectCollectionWorkspace(
            mobileTitle: 'Projects',
            showMobileHeader: false,
            controller: widget.projects,
            onOpen: widget.onOpen,
            onOpenResponsibilities: widget.onOpenResponsibilities,
          ),
          'role' => _CsmDetail(
            key: const ValueKey('role'),
            access: widget.access,
            embedded: true,
          ),
          _ => RefreshIndicator(
            onRefresh: load,
            child: ListView(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
              physics: const AlwaysScrollableScrollPhysics(),
              children: [
                MobileSurface(
                  child: Builder(
                    builder: (context) => Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Client work',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        const SizedBox(height: 8),
                        const Text(
                          'Briefs, conversations and next actions, together.',
                        ),
                        const SizedBox(height: 16),
                        FilledButton.icon(
                          onPressed: widget.projects.canCreate ? add : null,
                          icon: const Icon(Icons.add_rounded),
                          label: const Text('Add a client'),
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 20),
                if (loading)
                  const Padding(
                    padding: EdgeInsets.all(32),
                    child: Center(child: CircularProgressIndicator()),
                  )
                else if (error != null)
                  _Message(error!, action: 'Try again', onAction: load)
                else if (clients.isEmpty)
                  const _Message(
                    'Your first client starts here. Add a name and brief, then attach meeting notes, screenshots or documents.',
                  )
                else
                  ...clients.map(
                    (client) => Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: MobileSurface(
                        child: ListTile(
                          contentPadding: EdgeInsets.zero,
                          leading: CircleAvatar(
                            child: Text(
                              client.project.title.isEmpty
                                  ? 'C'
                                  : client.project.title
                                        .substring(0, 1)
                                        .toUpperCase(),
                            ),
                          ),
                          title: Text(client.project.title),
                          subtitle: Text(
                            '${client.profile['role'] == 'lead' ? 'Lead CSM' : 'Secondary CSM'} · ${client.sourceCount} ${client.sourceCount == 1 ? 'source' : 'sources'}${client.profile['nextReviewDate'] == null ? '' : '\nReview ${_friendlyDate(context, client.profile['nextReviewDate'])}'}',
                          ),
                          trailing: const Icon(Icons.chevron_right_rounded),
                          onTap: () => open(client.project),
                        ),
                      ),
                    ),
                  ),
                if (truncated)
                  const _Message(
                    'Showing clients from your 100 most recent projects. Open Projects to find older work.',
                  ),
              ],
            ),
          ),
        },
      ),
    ],
  );
}

class _CsmDetail extends ConsumerStatefulWidget {
  const _CsmDetail({
    super.key,
    required this.access,
    this.project,
    this.onOpenTasks,
    this.onClose,
    this.embedded = false,
  });
  final NativeWorkspaceAccess access;
  final Project? project;
  final VoidCallback? onOpenTasks, onClose;
  final bool embedded;
  @override
  ConsumerState<_CsmDetail> createState() => _CsmDetailState();
}

class _CsmDetailState extends ConsumerState<_CsmDetail> {
  late final repository = CsmRepository(widget.access);
  CsmSnapshot? saved;
  bool loading = true, busy = false, reloadRequired = false;
  String? error;
  bool get role => widget.project == null;
  bool get writable =>
      saved?.canWrite == true &&
      widget.project?.status != 'archived' &&
      !busy &&
      !loading &&
      !reloadRequired &&
      !repository.hasPending;
  @override
  void initState() {
    super.initState();
    unawaited(load());
  }

  @override
  void dispose() {
    repository.dispose();
    super.dispose();
  }

  Future<void> load() async {
    if (!repository.current || busy) return;
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final data = await repository.read(widget.project?.id);
      if (mounted && repository.current) {
        setState(() {
          saved = data;
          reloadRequired = false;
        });
      }
    } catch (_) {
      if (mounted && repository.current) {
        setState(
          () => error = 'This context could not be loaded. Try again when you are connected.',
        );
      }
    } finally {
      if (mounted && repository.current) setState(() => loading = false);
    }
  }

  Future<void> mutation(Future<CsmSnapshot> Function() action) async {
    if (!repository.current || busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final data = await action();
      if (mounted && repository.current) {
        setState(() {
          saved = data;
          reloadRequired = false;
        });
      }
    } catch (failure) {
      if (mounted && repository.current) {
        setState(() {
          reloadRequired = failure is ApiException && failure.statusCode == 409;
          error = reloadRequired
              ? 'This context changed elsewhere. Reload the current version before making another change.'
              : repository.hasPending
              ? 'The save could not be confirmed. Retry the same change to resolve it safely.'
              : failure is ApiException
              ? failure.message
              : 'The response could not be verified. Try again.';
        });
      }
    } finally {
      if (mounted && repository.current) setState(() => busy = false);
    }
  }

  Future<void> edit() async {
    if (!writable) return;
    final data = await Navigator.of(context).push<CsmSnapshot>(
      MaterialPageRoute(
        builder: (_) => _CsmEditor(
          access: widget.access,
          saved: saved!,
          project: widget.project,
        ),
      ),
    );
    if (mounted && repository.current && data != null) {
      setState(() {
        saved = data;
        error = null;
      });
    }
  }

  Future<void> attach() async {
    if (!writable) return;
    final picked = await showNativeLibraryPicker(context);
    if (!mounted ||
        !repository.current ||
        picked == null ||
        !picked.matchesCurrent(widget.access)) {
      return;
    }
    if (role && !repository.privateRoleSource(picked.item)) {
      setState(
        () => error = 'Choose a private file without client or workspace sharing. Client material belongs in its client brief.',
      );
      return;
    }
    await mutation(
      () => repository.write(
        widget.project?.id,
        {
          'libraryItemId': picked.item.id,
          'versionId': picked.item.versionId,
          'contentSha256': picked.item.version['contentSha256'],
          'expectedRevision': saved!.revision,
        },
        method: 'POST',
        source: true,
      ),
    );
  }

  Future<void> remove(CsmJson link, String title) async {
    if (!writable) return;
    final yes = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Remove this link?'),
        content: Text(
          '“$title” will no longer be included in this ${role ? 'role context' : 'client brief'}. The original stays in Library.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Keep'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Remove link'),
          ),
        ],
      ),
    );
    if (!mounted || !repository.current || yes != true) return;
    await mutation(
      () => repository.write(
        widget.project?.id,
        {
          'libraryItemId': link['libraryItemId'],
          'expectedRevision': saved!.revision,
        },
        method: 'DELETE',
        source: true,
      ),
    );
  }

  Future<void> ask(String task) async {
    if (!repository.current ||
        busy ||
        saved == null ||
        repository.hasPending ||
        reloadRequired) {
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    try {
      var agent = await repository.clientAgent();
      if (!mounted || !repository.current) return;
      if (agent == null) {
        final approved = await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            title: const Text('Set up your client partner?'),
            content: const Text(
              'Create Client Success Partner with read-only access to the selected client and supplied evidence. It can research the web, prepare reviews and suggest next actions. It cannot send messages or change client systems.',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('Later'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text('Create partner'),
              ),
            ],
          ),
        );
        if (!mounted || !repository.current || approved != true) return;
        agent = await repository.createClientAgent();
        if (!mounted || !repository.current) return;
      }
      final project = widget.project!;
      final draft = TalkDraftHandoff(
        id: 'csm:${DateTime.now().microsecondsSinceEpoch}',
        prompt:
            'Client: ${project.title}. $task Use my saved CSM role context and this client’s saved brief and linked evidence. Cite sources, distinguish facts from suggestions, and identify missing or stale context.',
        project: TalkCommandContextReference(
          kind: 'project',
          id: project.id,
          label: project.title,
          description: 'Client brief and linked evidence',
          selectable: true,
        ),
        agentId: agent.id,
        agentName: agent.name,
        authority: widget.access.authority,
      );
      ref.read(csmDraftProvider.notifier).stage(draft);
      context.go('/talk');
    } catch (failure) {
      if (mounted && repository.current) {
        setState(
          () => error = failure is ApiException
              ? failure.message
              : 'Your client assistant could not be opened. Try again.',
        );
      }
    } finally {
      if (mounted && repository.current) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = saved;
    final body = ListView(
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
      children: [
        if (loading)
          const Padding(
            padding: EdgeInsets.all(36),
            child: Center(child: CircularProgressIndicator()),
          ),
        if (error != null)
          _Message(
            error!,
            action: repository.hasPending ? 'Retry same change' : 'Reload',
            onAction: busy
                ? null
                : repository.hasPending
                ? () => mutation(() => repository.retry(widget.project?.id))
                : load,
          ),
        if (s != null) ...[
          MobileSurface(
            spotlight: true,
            child: Builder(
              builder: (context) => Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    role ? 'How you make a difference' : widget.project!.title,
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    role
                        ? 'Teach ATLAS your responsibilities, working style and customer-success approach. These notes accompany every client conversation.'
                        : '${s.profile['role'] == 'lead' ? 'Lead CSM' : 'Secondary CSM'} · ${_planLabel(s.profile['successPlan'])}',
                  ),
                  const SizedBox(height: 16),
                  FilledButton.icon(
                    onPressed: writable ? edit : null,
                    icon: const Icon(Icons.edit_outlined),
                    label: Text(
                      role
                          ? 'Edit my role notes'
                          : s.raw['profile'] == null
                          ? 'Set up client brief'
                          : 'Edit client brief',
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 20),
          if (role)
            MobileSurface(
              child: Text(
                s.text.isEmpty
                    ? 'Start with what you own, how you work with lead CSMs and the context you want ATLAS to remember.'
                    : s.text,
              ),
            )
          else ...[
            if (widget.onOpenTasks != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: OutlinedButton.icon(
                  onPressed: widget.onOpenTasks,
                  icon: const Icon(Icons.checklist_rounded),
                  label: const Text('Tasks & deliverables'),
                ),
              ),
            _DetailField('Customer goals', s.profile['customerGoals']),
            _DetailField('Success path', s.profile['successPath']),
            _DetailField(
              'People & responsibilities',
              s.profile['stakeholders'],
            ),
            if ((s.profile['leadCsm'] as String).isNotEmpty)
              _DetailField('Lead CSM', s.profile['leadCsm']),
            if (s.profile['nextReviewDate'] != null)
              _DetailField(
                'Next review',
                _friendlyDate(context, s.profile['nextReviewDate']),
              ),
            const SizedBox(height: 8),
            Text(
              'Prepare with ATLAS',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final choice in const [
                  (
                    'Client brief',
                    'Prepare a concise client brief and three next actions.',
                  ),
                  (
                    'Review prep',
                    'Prepare the next success review, with an agenda, open questions and a prioritized checklist.',
                  ),
                  (
                    'Next actions',
                    'Suggest useful next actions with proposed owners, dates to confirm and supporting evidence.',
                  ),
                ])
                  ActionChip(
                    label: Text(choice.$1),
                    avatar: const Icon(Icons.auto_awesome_outlined, size: 18),
                    onPressed: busy ? null : () => ask(choice.$2),
                  ),
              ],
            ),
            const SizedBox(height: 22),
          ],
          Row(
            children: [
              Expanded(
                child: Text(
                  role ? 'Role sources' : 'Client sources',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
              ),
              IconButton(
                onPressed:
                    writable &&
                        (role || s.raw['profile'] != null) &&
                        s.links.length < 50
                    ? attach
                    : null,
                icon: const Icon(Icons.add_link_rounded),
                tooltip: 'Attach from Library',
              ),
            ],
          ),
          Text(
            role
                ? 'Your private documents, screenshots and notes. Upload in Capture, then attach them here.'
                : 'Meeting notes, decks, screenshots and documents. Upload in Capture, then attach them here.',
          ),
          const SizedBox(height: 12),
          if (s.links.isEmpty)
            const _Message(
              'No sources attached yet. Add the material you want ATLAS to use.',
            ),
          ...s.links.map((link) {
            final matches = s.sources.where(
              (item) => item.id == link['libraryItemId'],
            );
            final item = matches.isEmpty ? null : matches.first;
            final title = item?.title ?? 'Source unavailable';
            final status = switch (link['status']) {
              'current' => 'Ready to use',
              'processing' => 'Being prepared',
              'changed' => 'Updated in Library · attach again to refresh',
              _ => 'Not available',
            };
            return Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: MobileSurface(
                child: ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.description_outlined),
                  title: Text(title),
                  subtitle: Text(status),
                  onTap: item == null
                      ? null
                      : () => Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (_) => NativeLibraryPage(
                              initialLibraryItemId: item.id,
                            ),
                          ),
                        ),
                  trailing: IconButton(
                    onPressed: writable ? () => remove(link, title) : null,
                    icon: const Icon(Icons.link_off_rounded),
                    tooltip: 'Remove source link',
                  ),
                ),
              ),
            );
          }),
        ],
        if (!loading && s == null && error == null)
          _Message('No context available.', action: 'Reload', onAction: load),
        if (busy)
          const Padding(
            padding: EdgeInsets.all(16),
            child: LinearProgressIndicator(),
          ),
      ],
    );
    if (widget.embedded) return body;
    return Scaffold(
      appBar: AppBar(
        leading: widget.onClose == null
            ? null
            : BackButton(onPressed: widget.onClose),
        title: Text(widget.project?.title ?? 'My CSM role'),
      ),
      body: SafeArea(top: false, child: body),
    );
  }
}

String _friendlyDate(BuildContext context, Object? value) {
  final date = value is String ? DateTime.tryParse(value) : null;
  return date == null
      ? 'Not scheduled'
      : MaterialLocalizations.of(context).formatMediumDate(date);
}

String _planLabel(Object? value) => switch (value) {
  'standard' => 'Standard plan',
  'premier' => 'Premier plan',
  'signature' => 'Signature plan',
  _ => 'Plan not yet confirmed',
};

class _DetailField extends StatelessWidget {
  const _DetailField(this.title, this.value);
  final String title;
  final Object? value;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 6),
        Text(
          value is String && (value as String).isNotEmpty
              ? value as String
              : 'Not added yet',
          style: Theme.of(context).textTheme.bodyMedium,
        ),
      ],
    ),
  );
}

class _Message extends StatelessWidget {
  const _Message(this.text, {this.action, this.onAction});
  final String text;
  final String? action;
  final VoidCallback? onAction;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 12),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(text),
        if (action != null)
          TextButton(onPressed: onAction, child: Text(action!)),
      ],
    ),
  );
}

class _CsmEditor extends StatefulWidget {
  const _CsmEditor({required this.access, required this.saved, this.project});
  final NativeWorkspaceAccess access;
  final CsmSnapshot saved;
  final Project? project;
  @override
  State<_CsmEditor> createState() => _CsmEditorState();
}

class _CsmEditorState extends State<_CsmEditor> {
  late final repository = CsmRepository(widget.access);
  late CsmSnapshot saved = widget.saved;
  late final notes = TextEditingController(text: saved.text);
  late final fields = <String, TextEditingController>{
    for (final key in [
      'leadCsm',
      'customerGoals',
      'successPath',
      'stakeholders',
    ])
      key: TextEditingController(text: saved.profile[key] as String),
  };
  late String csmRole = saved.profile['role'] as String,
      plan = saved.profile['successPlan'] as String;
  late String? reviewDate = saved.profile['nextReviewDate'] as String?;
  bool busy = false, conflict = false, leaving = false;
  String? error;
  bool get role => widget.project == null;
  bool get dirty => role
      ? notes.text != saved.text
      : csmRole != saved.profile['role'] ||
            plan != saved.profile['successPlan'] ||
            reviewDate != saved.profile['nextReviewDate'] ||
            fields.entries.any((e) => e.value.text != saved.profile[e.key]);
  @override
  void dispose() {
    repository.dispose();
    notes.dispose();
    for (final c in fields.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> close() async {
    if (busy || !repository.current) return;
    if (dirty || repository.hasPending) {
      final yes = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(
            repository.hasPending
                ? 'Leave an unconfirmed save?'
                : 'Discard these edits?',
          ),
          content: Text(
            repository.hasPending
                ? 'The save may have reached the service. Reopen this context to see what was saved.'
                : 'Your saved context will stay as it is.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Keep editing'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Leave'),
            ),
          ],
        ),
      );
      if (!mounted || !repository.current || yes != true) return;
    }
    setState(() => leaving = true);
    if (mounted) Navigator.pop(context);
  }

  Future<void> save() async {
    if (busy || conflict || !repository.current) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final result = repository.hasPending
          ? await repository.retry(widget.project?.id)
          : await repository.write(widget.project?.id, {
              'expectedRevision': saved.revision,
              if (role)
                'text': notes.text.trim()
              else
                'profile': {
                  'role': csmRole,
                  'successPlan': plan,
                  for (final entry in fields.entries)
                    entry.key: entry.value.text.trim(),
                  if (reviewDate != null) 'nextReviewDate': reviewDate,
                },
            });
      if (mounted && repository.current) {
        setState(() => leaving = true);
        Navigator.pop(context, result);
      }
    } catch (failure) {
      if (mounted && repository.current) {
        setState(() {
          conflict = failure is ApiException && failure.statusCode == 409;
          error = conflict
              ? 'This context changed elsewhere. Keep your draft and load the latest version to compare before saving.'
              : repository.hasPending
              ? 'The save was not confirmed. Retry sends the exact same change.'
              : failure is ApiException
              ? failure.message
              : 'The saved response could not be verified.';
        });
      }
    } finally {
      if (mounted && repository.current) setState(() => busy = false);
    }
  }

  Future<void> reload() async {
    if (busy || !repository.current) return;
    setState(() => busy = true);
    try {
      final latest = await repository.read(widget.project?.id);
      if (!mounted || !repository.current) return;
      await Navigator.of(context).push<void>(
        MaterialPageRoute(
          builder: (context) => MobileFlowScaffold(
            title: 'Current saved context',
            footer: FilledButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Back to my draft'),
            ),
            child: role
                ? SelectableText(
                    latest.text.isEmpty ? 'No notes saved' : latest.text,
                  )
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      for (final entry in const {
                        'role': 'Your role',
                        'successPlan': 'Success plan',
                        'leadCsm': 'Lead CSM',
                        'customerGoals': 'Customer goals',
                        'successPath': 'Success path',
                        'stakeholders': 'People & responsibilities',
                        'nextReviewDate': 'Next review',
                      }.entries)
                        _DetailField(entry.value, switch (entry.key) {
                          'role' =>
                            latest.profile['role'] == 'lead'
                                ? 'Lead CSM'
                                : 'Secondary CSM',
                          'successPlan' => _planLabel(
                            latest.profile['successPlan'],
                          ),
                          'nextReviewDate' => _friendlyDate(
                            context,
                            latest.profile['nextReviewDate'],
                          ),
                          _ => latest.profile[entry.key],
                        }),
                    ],
                  ),
          ),
        ),
      );
      if (!mounted || !repository.current) return;
      setState(() {
        saved = latest;
        conflict = false;
        error = 'Your draft is unchanged. Review it, then save to replace the version you just read.';
      });
    } catch (_) {
      if (mounted && repository.current) {
        setState(
          () => error = 'The latest context could not be loaded. Your draft is still here.',
        );
      }
    } finally {
      if (mounted && repository.current) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: leaving,
    onPopInvokedWithResult: (didPop, _) {
      if (!didPop) unawaited(close());
    },
    child: MobileFlowScaffold(
      title: role ? 'My CSM role' : 'Client brief',
      onClose: close,
      footer: FilledButton.icon(
        onPressed: busy || conflict ? null : save,
        icon: busy
            ? const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : const Icon(Icons.check_rounded),
        label: Text(repository.hasPending ? 'Retry same save' : 'Save context'),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (error != null)
            _Message(
              error!,
              action: conflict ? 'Read latest version' : null,
              onAction: conflict ? reload : null,
            ),
          if (role) ...[
            const Text(
              'Your responsibilities, ways of working and what good customer success looks like to you.',
            ),
            const SizedBox(height: 16),
            TextField(
              controller: notes,
              enabled: !busy && !repository.hasPending,
              maxLength: 20000,
              minLines: 12,
              maxLines: null,
              textCapitalization: TextCapitalization.sentences,
              decoration: const InputDecoration(
                labelText: 'Role notes',
                alignLabelWithHint: true,
                hintText: 'I usually work as a secondary CSM…',
              ),
            ),
          ] else ...[
            DropdownButtonFormField<String>(
              initialValue: csmRole,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Your role'),
              items: const [
                DropdownMenuItem(
                  value: 'secondary',
                  child: Text('Secondary CSM'),
                ),
                DropdownMenuItem(value: 'lead', child: Text('Lead CSM')),
              ],
              onChanged: busy || repository.hasPending
                  ? null
                  : (v) => setState(() => csmRole = v!),
            ),
            const SizedBox(height: 16),
            DropdownButtonFormField<String>(
              initialValue: plan,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Success plan'),
              items: [
                for (final v in ['unknown', 'standard', 'premier', 'signature'])
                  DropdownMenuItem(value: v, child: Text(_planLabel(v))),
              ],
              onChanged: busy || repository.hasPending
                  ? null
                  : (v) => setState(() => plan = v!),
            ),
            const SizedBox(height: 16),
            for (final entry in const {
              'leadCsm': 'Lead CSM',
              'customerGoals': 'Customer goals',
              'successPath': 'Success path',
              'stakeholders': 'People & responsibilities',
            }.entries)
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: TextField(
                  controller: fields[entry.key],
                  enabled: !busy && !repository.hasPending,
                  minLines: entry.key == 'leadCsm' ? 1 : 3,
                  maxLines: null,
                  maxLength: entry.key == 'leadCsm' ? 240 : 4000,
                  textCapitalization: TextCapitalization.sentences,
                  decoration: InputDecoration(
                    labelText: entry.value,
                    alignLabelWithHint: true,
                  ),
                ),
              ),
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.event_outlined),
              title: const Text('Next review'),
              subtitle: Text(
                reviewDate == null
                    ? 'Choose a date'
                    : _friendlyDate(context, reviewDate),
              ),
              trailing: reviewDate == null
                  ? const Icon(Icons.chevron_right_rounded)
                  : IconButton(
                      tooltip: 'Clear review date',
                      onPressed: busy || repository.hasPending
                          ? null
                          : () => setState(() => reviewDate = null),
                      icon: const Icon(Icons.close_rounded),
                    ),
              onTap: busy || repository.hasPending
                  ? null
                  : () async {
                      final date = await showDatePicker(
                        context: context,
                        initialDate:
                            DateTime.tryParse(reviewDate ?? '') ??
                            DateTime.now(),
                        firstDate: DateTime(2000),
                        lastDate: DateTime(2100),
                      );
                      if (mounted && repository.current && date != null) {
                        setState(
                          () => reviewDate =
                              '${date.year}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}',
                        );
                      }
                    },
            ),
          ],
        ],
      ),
    ),
  );
}

class _NewClient extends StatefulWidget {
  const _NewClient({required this.access, required this.projects});
  final NativeWorkspaceAccess access;
  final ProjectsController projects;
  @override
  State<_NewClient> createState() => _NewClientState();
}

class _NewClientState extends State<_NewClient> {
  final name = TextEditingController(), goal = TextEditingController();
  late final repository = CsmRepository(widget.access);
  Project? created;
  bool busy = false, uncertainProject = false, leaving = false;
  String? error;
  @override
  void dispose() {
    name.dispose();
    goal.dispose();
    repository.dispose();
    super.dispose();
  }

  Future<void> create() async {
    if (!repository.current || busy || name.text.trim().isEmpty) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      if (created == null) {
        uncertainProject = true;
        created = await widget.projects.create(
          title: name.text.trim(),
          objective: goal.text.trim().isEmpty
              ? 'Build client context and plan customer-success work.'
              : goal.text.trim(),
        );
        if (!mounted || !repository.current) return;
        if (created == null) {
          final failure = widget.projects.error;
          if (failure is ApiException &&
              const [
                400,
                401,
                403,
                404,
                409,
                422,
              ].contains(failure.statusCode)) {
            uncertainProject = false;
          }
          throw const ApiException(
            'Client creation was not confirmed. Retry with the same details to avoid a duplicate.',
          );
        }
        uncertainProject = false;
      }
      if (repository.hasPending) {
        await repository.retry(created!.id);
      } else {
        await repository.write(created!.id, {
          'expectedRevision': null,
          'profile': {...emptyCsmProfile(), 'customerGoals': goal.text.trim()},
        });
      }
      if (mounted && repository.current) {
        setState(() => leaving = true);
        Navigator.pop(context, created);
      }
    } catch (failure) {
      if (mounted && repository.current) {
        setState(
          () => error = created == null
              ? (failure is ApiException
                    ? failure.message
                    : 'Client creation could not be confirmed. Retry the same details.')
              : 'The project is saved. Retry to finish the client brief; this will reuse the same project.',
        );
      }
    } finally {
      if (mounted && repository.current) setState(() => busy = false);
    }
  }

  Future<void> close() async {
    if (busy) return;
    if (name.text.isNotEmpty || created != null || uncertainProject) {
      final yes = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Leave client setup?'),
          content: Text(
            created != null
                ? 'The project has been saved. You can find it under Projects and finish its client brief later.'
                : uncertainProject
                ? 'Creation may have reached the service. Check Projects before creating another client.'
                : 'The client has not been saved.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Stay'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Leave'),
            ),
          ],
        ),
      );
      if (!mounted || !repository.current || yes != true) return;
    }
    setState(() => leaving = true);
    Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: leaving,
    onPopInvokedWithResult: (didPop, _) {
      if (!didPop) unawaited(close());
    },
    child: MobileFlowScaffold(
      title: 'Add a client',
      onClose: close,
      footer: FilledButton(
        onPressed: busy ? null : create,
        child: Text(
          busy
              ? 'Saving…'
              : created != null
              ? 'Finish client setup'
              : uncertainProject
              ? 'Retry same client'
              : 'Create client',
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'A private place for your client’s goals, conversations and next actions.',
          ),
          const SizedBox(height: 24),
          if (error != null) _Message(error!),
          TextField(
            controller: name,
            enabled: !busy && created == null && !uncertainProject,
            maxLength: 180,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(
              labelText: 'Client name',
              hintText: 'Who are you working with?',
            ),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: goal,
            enabled: !busy && created == null && !uncertainProject,
            maxLength: 2000,
            minLines: 4,
            maxLines: null,
            textCapitalization: TextCapitalization.sentences,
            decoration: const InputDecoration(
              labelText: 'What matters to this client?',
              alignLabelWithHint: true,
              hintText: 'Goals, priorities or a short introduction',
            ),
          ),
          const SizedBox(height: 12),
          const Text(
            'You can add your CSM role, success plan, stakeholders and source material next.',
          ),
        ],
      ),
    ),
  );
}

/// Entry from an existing project, including a client whose initial brief save was interrupted.
class MobileClientBriefEntry extends ConsumerWidget {
  const MobileClientBriefEntry({
    super.key,
    required this.projectId,
    required this.projects,
  });
  final String projectId;
  final ProjectsRepository projects;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final access = ref.watch(nativeWorkspaceAccessProvider);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
      child: OutlinedButton.icon(
        icon: const Icon(Icons.badge_outlined),
        label: const Text('Client brief & context'),
        onPressed: access == null
            ? null
            : () async {
                try {
                  final project = await projects.detail(projectId);
                  if (!context.mounted || !access.current) return;
                  await Navigator.of(context).push<void>(
                    MaterialPageRoute(
                      builder: (_) => NativePrivateWorkspace(
                        ownNavigator: true,
                        builder: (current) =>
                            current.identity == access.identity
                            ? _CsmDetail(
                                access: current,
                                project: project,
                                onClose: () => Navigator.of(context).pop(),
                              )
                            : const SizedBox.shrink(),
                      ),
                    ),
                  );
                } catch (_) {
                  if (context.mounted && access.current) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text(
                          'The client workspace could not be opened. Try again.',
                        ),
                      ),
                    );
                  }
                }
              },
      ),
    );
  }
}
