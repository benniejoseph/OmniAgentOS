import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../features/auth/application/biometric_session_lock_controller.dart';
import '../../features/auth/application/session_controller.dart';
import 'api_client.dart';

/// Current authenticated workspace identity. This is never persisted as a grant.
class NativeWorkspaceAccess {
  const NativeWorkspaceAccess(this.api, this.authority, this.canManage);
  final ApiClient api;
  final NativeRequestAuthority authority;
  final bool canManage;
  bool get current => authority.isCurrent();
  Object get identity => (
    api,
    authority,
    authority.apiBaseUrl,
    authority.tenantId,
    authority.actorId,
    authority.canonicalUserId,
    authority.role,
  );
}

final nativeWorkspaceAccessProvider =
    Provider.autoDispose<NativeWorkspaceAccess?>((ref) {
      var active = true;
      ref.onDispose(() => active = false);
      final api = ref.watch(apiClientProvider);
      final state = ref.watch(sessionControllerProvider);
      final locked = ref
          .watch(biometricSessionLockControllerProvider)
          .state
          .blocksInteraction;
      final session = state.value;
      if (state.isLoading ||
          state.hasError ||
          locked ||
          session == null ||
          [
            session.tenantId,
            session.actorId,
            session.userId,
            session.role,
          ].any((value) => value.trim().isEmpty) ||
          !RegExp(
            r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
          ).hasMatch(session.userId) ||
          !{'viewer', 'operator', 'admin', 'system'}.contains(session.role) ||
          (session.actorId != 'actor:${session.userId.toLowerCase()}' &&
              session.actorId.trim().toLowerCase() !=
                  session.email.trim().toLowerCase())) {
        return null;
      }
      String origin;
      try {
        origin = NativeRequestAuthority.normalizeApiBaseUrl(api.apiBaseUrl);
      } catch (_) {
        return null;
      }
      bool current() {
        if (!active ||
            !ref.mounted ||
            !identical(ref.read(apiClientProvider), api)) {
          return false;
        }
        if (!active || !ref.mounted) return false;
        final next = ref.read(sessionControllerProvider);
        final owner = next.value;
        if (next.isLoading ||
            next.hasError ||
            owner == null ||
            ref
                .read(biometricSessionLockControllerProvider)
                .state
                .blocksInteraction) {
          return false;
        }
        try {
          final currentOrigin = NativeRequestAuthority.normalizeApiBaseUrl(
            api.apiBaseUrl,
          );
          return active &&
              ref.mounted &&
              currentOrigin == origin &&
              owner.tenantId == session.tenantId &&
              owner.actorId == session.actorId &&
              owner.userId == session.userId &&
              owner.role == session.role;
        } catch (_) {
          return false;
        }
      }

      return NativeWorkspaceAccess(
        api,
        NativeRequestAuthority(
          tenantId: session.tenantId,
          actorId: session.actorId,
          canonicalUserId: session.userId,
          role: session.role,
          apiBaseUrl: origin,
          isCurrent: current,
        ),
        session.canManage,
      );
    });

/// Discards private presentation state whenever its owner, role, API or lock changes.
class NativePrivateWorkspace extends ConsumerWidget {
  const NativePrivateWorkspace({
    super.key,
    required this.builder,
    this.requireManager = false,
    this.ownNavigator = false,
  });
  final Widget Function(NativeWorkspaceAccess access) builder;
  final bool requireManager;
  final bool ownNavigator;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final access = ref.watch(nativeWorkspaceAccessProvider);
    if (access == null ||
        !access.current ||
        (requireManager && !access.canManage)) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text(
            'Unlock and sign in to an authorized workspace to continue.',
          ),
        ),
      );
    }
    if (ownNavigator) {
      return Navigator(
        key: ValueKey(access.identity),
        onGenerateRoute: (_) =>
            MaterialPageRoute<void>(builder: (_) => builder(access)),
      );
    }
    return KeyedSubtree(key: ValueKey(access.identity), child: builder(access));
  }
}

/// Opens a fixed first-party workspace destination, without transferring credentials.
class NativeWorkspaceBrowserButton extends ConsumerWidget {
  const NativeWorkspaceBrowserButton({
    super.key,
    required this.path,
    required this.label,
  });
  final String path, label;
  static const allowedPaths = {
    '/app/payments',
    '/app/settings',
    '/app/security',
    '/app/evaluations',
    '/app/observability',
    '/app/automation',
    '/app/workflows',
    '/app/connectors',
    '/app/agents',
  };
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final access = ref.watch(nativeWorkspaceAccessProvider);
    return OutlinedButton.icon(
      icon: const Icon(Icons.open_in_browser_outlined, size: 18),
      label: Text(label),
      onPressed:
          access == null || !access.current || !allowedPaths.contains(path)
          ? null
          : () async {
              try {
                if (!access.current) return;
                final base = Uri.parse(access.authority.apiBaseUrl);
                final uri = base.replace(
                  path: path,
                  query: null,
                  fragment: null,
                );
                final loopback = {
                  'localhost',
                  '127.0.0.1',
                  '::1',
                }.contains(uri.host);
                if (uri.scheme != 'https' &&
                    !(loopback && uri.scheme == 'http')) {
                  throw const FormatException(
                    'A secure workspace address is required.',
                  );
                }
                if (!await launchUrl(
                  uri,
                  mode: LaunchMode.externalApplication,
                )) {
                  throw StateError('The browser could not be opened.');
                }
              } catch (_) {
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(
                      content: Text(
                        'Could not open the workspace in your browser. Try again.',
                      ),
                    ),
                  );
                }
              }
            },
    );
  }
}
