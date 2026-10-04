import 'package:dio/dio.dart';
import 'package:flutter/material.dart';

import '../../core/network/native_workspace_access.dart';
import 'library_contracts.dart';
import 'library_controller.dart';
import 'library_repository.dart';

/// A current selection is metadata, not a grant to read or mutate an entity.
/// Consumers preserve the entity ID and recheck their own live access before use.
class AuthorizedEntitySelection {
  const AuthorizedEntitySelection(
    this.option,
    this.tenantId,
    this.ownerActorId,
    this.accessScopeSha256,
    this.workspaceIdentity,
  );
  final EntityOption option;
  final String tenantId, ownerActorId, accessScopeSha256;
  final Object workspaceIdentity;
  bool matchesCurrent(NativeWorkspaceAccess access) =>
      access.current && access.identity == workspaceIdentity;
}

Future<AuthorizedEntitySelection?> showNativeEntitySelector(
  BuildContext context, {
  Set<String> types = const {'person', 'organization', 'account', 'project'},
}) => Navigator.of(context).push<AuthorizedEntitySelection>(
  MaterialPageRoute(
    builder: (_) => NativeEntityOptionsPage(select: true, types: types),
  ),
);

class NativeEntityOptionsPage extends StatelessWidget {
  const NativeEntityOptionsPage({
    super.key,
    this.select = false,
    this.types = const {'person', 'organization', 'account', 'project'},
  });
  final bool select;
  final Set<String> types;
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(
        select ? 'Choose an authorized entity' : 'Authorized entities',
      ),
    ),
    body: NativePrivateWorkspace(
      builder: (access) => _EntityOptionsView(
        key: ValueKey(access.identity),
        access: access,
        select: select,
        types: types,
      ),
    ),
  );
}

class _EntityOptionsView extends StatefulWidget {
  const _EntityOptionsView({
    super.key,
    required this.access,
    required this.select,
    required this.types,
  });
  final NativeWorkspaceAccess access;
  final bool select;
  final Set<String> types;
  @override
  State<_EntityOptionsView> createState() => _EntityOptionsViewState();
}

class _EntityOptionsViewState extends State<_EntityOptionsView>
    with WidgetsBindingObserver {
  late final repository = ApiLibraryRepository(widget.access);
  CancelToken? _token;
  EntityOptionsPage? _page;
  String? _error;
  bool _loading = false, _visible = true, _denied = false;
  final List<String?> _afters = [null];
  final _heading = FocusNode();
  bool get _current => mounted && _visible && widget.access.current;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _read();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _visible = state == AppLifecycleState.resumed;
    _token?.cancel('Entity selection was hidden.');
    if (!_visible) {
      setState(() {
        _page = null;
        _loading = false;
      });
    } else {
      _read();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _token?.cancel('Entity selection closed.');
    _heading.dispose();
    super.dispose();
  }

  Future<void> _read({
    String? after,
    bool next = false,
    bool previous = false,
  }) async {
    if (!_current) return;
    _token?.cancel('A newer options read replaced this request.');
    final token = _token = CancelToken(), target = after ?? _afters.last;
    setState(() {
      _loading = true;
      _error = null;
      _denied = false;
    });
    try {
      final page = await repository.entities(token, after: target);
      if (!_current || !identical(_token, token) || token.isCancelled) return;
      setState(() {
        _page = page;
        if (next) _afters.add(target);
        if (previous) _afters.removeLast();
      });
      if (next || previous) _heading.requestFocus();
    } catch (error) {
      if (!_current || !identical(_token, token) || token.isCancelled) return;
      // This exact selector has no independent domain state to preserve on refusal.
      setState(() {
        _page = null;
        _denied = true;
        _error = libraryReadError(error);
      });
    } finally {
      if (_current && identical(_token, token)) {
        setState(() => _loading = false);
      }
    }
  }

  void _choose(EntityOption option) {
    final page = _page;
    if (!_current ||
        _loading ||
        _denied ||
        page == null ||
        !page.items.contains(option) ||
        !widget.types.contains(option.type)) {
      return;
    }
    final access = widget.access;
    Navigator.of(context).pop(
      AuthorizedEntitySelection(
        option,
        access.authority.tenantId,
        'actor:${access.authority.canonicalUserId}',
        page.accessScope,
        access.identity,
      ),
    );
  }

  Future<void> _previous() async {
    if (_afters.length <= 1) return;
    final target = _afters[_afters.length - 2];
    if (target == null) {
      _afters
        ..clear()
        ..add(null);
      await _read();
    } else {
      await _read(after: target, previous: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_current) {
      return const Center(
        child: Text('Unlock and sign in to read current entity options.'),
      );
    }
    final rows =
        _page?.items.where((row) => widget.types.contains(row.type)).toList() ??
        const <EntityOption>[];
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 760),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Focus(
                focusNode: _heading,
                child: Semantics(
                  header: true,
                  child: Text(
                    'Current authorized entities',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                'A bounded page of current labels and exact registry identities. Choosing one does not grant authority, attach a source, or change a relationship. Entity project IDs are distinct from canonical Work project IDs.',
              ),
              const SizedBox(height: 16),
              Wrap(
                children: [
                  TextButton.icon(
                    onPressed: _loading ? null : () => _read(),
                    icon: const Icon(Icons.refresh),
                    label: const Text('Refresh entity options'),
                    style: TextButton.styleFrom(
                      minimumSize: const Size(48, 48),
                    ),
                  ),
                ],
              ),
              if (_loading) const Text('Reading current options…'),
              if (_error != null)
                Semantics(liveRegion: true, child: Text(_error!)),
              if (_page == null && !_loading)
                const Text(
                  'Options and total counts are unavailable until a valid read finishes.',
                ),
              if (_page != null) ...[
                Text(
                  '${_page!.items.length} options in this page${_page!.nextAfter != null ? ' · more available' : ' · end of the current readable options'}. The complete total is unavailable.',
                ),
                if (rows.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 20),
                    child: Text(
                      'No matching entity types occur in this page. Continue to another page when available.',
                    ),
                  ),
                for (final row in rows) ...[
                  const Divider(),
                  SelectableText(
                    row.label,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  Text(row.type),
                  SelectableText(row.id),
                  if (widget.select)
                    Align(
                      alignment: AlignmentDirectional.centerStart,
                      child: OutlinedButton(
                        onPressed: _loading || _denied
                            ? null
                            : () => _choose(row),
                        style: OutlinedButton.styleFrom(
                          minimumSize: const Size(48, 48),
                        ),
                        child: const Text('Choose this exact entity'),
                      ),
                    ),
                ],
                Wrap(
                  spacing: 12,
                  children: [
                    OutlinedButton(
                      onPressed: !_loading && _afters.length > 1
                          ? _previous
                          : null,
                      style: OutlinedButton.styleFrom(
                        minimumSize: const Size(48, 48),
                      ),
                      child: const Text('Previous options'),
                    ),
                    OutlinedButton(
                      onPressed: !_loading && _page!.nextAfter != null
                          ? () => _read(after: _page!.nextAfter, next: true)
                          : null,
                      style: OutlinedButton.styleFrom(
                        minimumSize: const Size(48, 48),
                      ),
                      child: const Text('Next options'),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                ExpansionTile(
                  title: const Text('Selection scope'),
                  children: [
                    SelectableText(
                      'Tenant ${widget.access.authority.tenantId}\nOwner actor:${widget.access.authority.canonicalUserId}\nAccess scope ${_page!.accessScope}\nPurpose entity.read.v1',
                    ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
