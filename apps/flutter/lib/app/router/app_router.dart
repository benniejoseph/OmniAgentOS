import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/network/api_client.dart';
import '../../core/platform/desktop_host_bridge.dart';
import '../../core/storage/secure_session_store.dart';
import '../../core/sync/reconnect_coordinator.dart';
import '../../features/ambient_voice/ambient_voice_consent.dart';
import '../../features/ambient_voice/realtime_voice_controller.dart';
import '../../features/activity/activity_providers.dart';
import '../../features/activity/activity_view.dart';
import '../../features/auth/application/biometric_session_lock_controller.dart';
import '../../features/auth/application/session_controller.dart';
import '../../features/auth/presentation/login_screen.dart';
import '../../features/auth/presentation/session_bootstrap_screen.dart';
import '../../features/agents/agents.dart';
import '../../features/agents/agent_control_view.dart';
import '../../features/agents/macos_agents_view.dart';
import '../../features/agents/agents_providers.dart';
import '../../features/automation/automation_studio_view.dart';
import '../../features/automation/macos_automation_studio_view.dart';
import '../../features/capture/capture.dart';
import '../../features/capture/capture_providers.dart';
import '../../features/computer_use/local_computer.dart';
import '../../features/companion/companion_entry.dart';
import '../../features/companion/companion_models.dart';
import '../../features/companion/companion_providers.dart';
import '../../features/customers/accounts_workspace.dart';
import '../../features/inbox/macos_inbox_view.dart';
import '../../features/inbox/inbox.dart';
import '../../features/inbox/inbox_providers.dart';
import '../../features/knowledge/knowledge.dart';
import '../../features/knowledge/macos_knowledge_view.dart';
import '../../features/knowledge/knowledge_providers.dart';
import '../../features/markets/markets_view.dart';
import '../../features/payments/macos_payments_view.dart';
import '../../features/payments/payments_view.dart';
import '../../features/meetings/meetings_page.dart';
import '../../features/projects/macos_project_detail_view.dart';
import '../../features/projects/projects_providers.dart';
import '../../features/projects/macos_projects_view.dart';
import '../../features/projects/projects_view.dart';
import '../../features/results/macos_result_detail_view.dart';
import '../../features/results/results_providers.dart';
import '../../features/results/macos_results_view.dart';
import '../../features/results/results_view.dart';
import '../../features/responsibilities/responsibility_providers.dart';
import '../../features/responsibilities/responsibility_workspace.dart';
import '../../features/settings/admin_console.dart';
import '../../features/settings/macos_admin_workspace_view.dart';
import '../../features/settings/model_settings_view.dart';
import '../../features/security/device_security_screen.dart';
import '../../features/talk/talk.dart';
import '../../features/talk/talk_providers.dart';
import '../../features/today/today.dart';
import '../../features/today/macos_today_view.dart';
import '../../features/today/today_providers.dart';
import '../navigation/adaptive_shell.dart';
import '../navigation/app_destination.dart';
import '../navigation/destination_placeholder.dart';
import '../platform/macos_presentation.dart';

String appHomePath() => !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS
    ? '/talk'
    : '/today';

bool isSafeInitialAppLocation(String route) {
  final uri = Uri.tryParse(route);
  if (uri == null ||
      uri.hasScheme ||
      uri.hasAuthority ||
      !route.startsWith('/') ||
      uri.normalizePath().toString() != route) {
    return false;
  }
  try {
    var decoded = uri.path;
    for (var attempt = 0; attempt < 4; attempt++) {
      if (RegExp(r'[\\\x00-\x20\x7f]').hasMatch(decoded) ||
          decoded.split('/').any((part) => part == '.' || part == '..')) {
        return false;
      }
      // Decode escaped byte runs for the safety check without feeding already
      // decoded Unicode (or a literal percent in an opaque ID) back into Uri.
      // The original route is returned unchanged to GoRouter for one decode.
      final next = decoded.replaceAllMapped(
        RegExp(r'(?:%[0-9a-fA-F]{2})+'),
        (match) => Uri.decodeComponent(match[0]!),
      );
      if (next == decoded) break;
      decoded = next;
    }
  } on FormatException {
    return false;
  } on ArgumentError {
    return false;
  }
  if (DesktopHostBridge.isWorkspaceRoute(route)) return true;
  final id = companionThreadId(uri.queryParameters['thread']);
  return id != null && route == '/talk?thread=$id';
}

String initialAppLocation(List<String> arguments) {
  const prefix = '--asael-route=';
  final route = arguments
      .where((argument) => argument.startsWith(prefix))
      .map((argument) => argument.substring(prefix.length))
      .lastOrNull;
  return route != null && isSafeInitialAppLocation(route)
      ? route
      : appHomePath();
}

bool hasExplicitInitialAppLocation(List<String> arguments) {
  const prefix = '--asael-route=';
  final route = arguments
      .where((argument) => argument.startsWith(prefix))
      .map((argument) => argument.substring(prefix.length))
      .lastOrNull;
  return route != null && isSafeInitialAppLocation(route);
}

final appInitialLocationProvider = Provider<String>((_) => appHomePath());
// Embedders that supply a location keep their explicit destination by default.
// main supplies false only for an ordinary launch with no validated route.
final appExplicitInitialLocationProvider = Provider<bool>((_) => true);
final _entryIntentProvider = Provider<_EntryIntent>((_) => _EntryIntent());

class _EntryIntent {
  String? location;
  bool hadSession = false;
  void remember(String value) {
    if (isSafeInitialAppLocation(value)) location = value;
  }

  String? take() {
    final value = location;
    location = null;
    return value;
  }
}

class ProviderBoundActivityRoute extends ConsumerWidget {
  const ProviderBoundActivityRoute({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) => ActivityView(
    controller: ref.watch(activityControllerProvider.select((value) => value)),
    onOpen: (location) => context.push(location),
  );
}

void _openResponsibility(BuildContext context, String id) {
  if (RegExp(r'^responsibility:[a-f0-9]{64}$').hasMatch(id)) {
    context.push('/responsibilities/${Uri.encodeComponent(id)}');
  }
}

class ProviderBoundResponsibilityRoute extends ConsumerWidget {
  const ProviderBoundResponsibilityRoute({super.key, this.focusId});
  final String? focusId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (focusId != null &&
        !RegExp(r'^responsibility:[a-f0-9]{64}$').hasMatch(focusId!)) {
      return const Scaffold(
        body: Center(child: Text('This Responsibility link is invalid.')),
      );
    }
    return ResponsibilityWorkspaceView(
      controller: ref.watch(
        responsibilityControllerProvider.select((value) => value),
      ),
      focusId: focusId,
      onOpenResponsibility: (id) => _openResponsibility(context, id),
      onNewDraft: () => context.go('/responsibilities'),
    );
  }
}

class ProviderBoundAccountsRoute extends StatelessWidget {
  const ProviderBoundAccountsRoute({super.key, this.id});
  final String? id;

  @override
  Widget build(BuildContext context) {
    if (id != null &&
        !RegExp(r'^customer-account:[a-f0-9]{64}$').hasMatch(id!)) {
      return const Scaffold(
        body: Center(child: Text('This customer account link is invalid.')),
      );
    }
    return NativeAccountsView(
      accountId: id,
      onOpen: (account) =>
          context.push('/accounts/${Uri.encodeComponent(account.id)}'),
    );
  }
}

class ProviderBoundMeetingsRoute extends StatelessWidget {
  const ProviderBoundMeetingsRoute({super.key});

  @override
  Widget build(BuildContext context) => NativeMeetingsPage(
    desktop: usesMacosPresentation(),
    onOpen: (meeting) =>
        context.push('/meetings/${Uri.encodeComponent(meeting.id)}'),
  );
}

class ProviderBoundMeetingRoute extends StatelessWidget {
  const ProviderBoundMeetingRoute({super.key, required this.id});
  final String id;

  @override
  Widget build(BuildContext context) {
    if (!RegExp(
      r'^meeting:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    ).hasMatch(id)) {
      return const Scaffold(
        body: Center(child: Text('This Meeting link is invalid.')),
      );
    }
    return NativeMeetingDetailPage(id: id, desktop: usesMacosPresentation());
  }
}

class ProviderBoundKnowledgeRoute extends ConsumerWidget {
  const ProviderBoundKnowledgeRoute({super.key, this.initialMemoryId});
  final String? initialMemoryId;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final controller = ref.watch(
      knowledgeControllerProvider.select((value) => value),
    );
    return usesMacosPresentation()
        ? MacosKnowledgeView(
            controller: controller,
            initialMemoryId: initialMemoryId,
          )
        : KnowledgeView(
            controller: controller,
            initialMemoryId: initialMemoryId,
          );
  }
}

class ProviderBoundCaptureRoute extends ConsumerWidget {
  const ProviderBoundCaptureRoute({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) => CaptureView(
    controller: ref.watch(captureControllerProvider.select((value) => value)),
    onOpenKnowledge: () => context.go('/knowledge'),
  );
}

class ProviderBoundProjectsRoute extends ConsumerWidget {
  const ProviderBoundProjectsRoute({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final controller = ref.watch(
      projectsControllerProvider.select((value) => value),
    );
    return usesMacosPresentation()
        ? MacosProjectsView(
            controller: controller,
            onOpenResponsibilities: () => context.go('/responsibilities'),
            onOpen: (project) =>
                context.push('/projects/${Uri.encodeComponent(project.id)}'),
          )
        : ProjectsView(
            controller: controller,
            onOpenResponsibilities: () => context.go('/responsibilities'),
            onOpen: (project) =>
                context.push('/projects/${Uri.encodeComponent(project.id)}'),
          );
  }
}

class ProviderBoundResultsRoute extends ConsumerWidget {
  const ProviderBoundResultsRoute({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final controller = ref.watch(
      resultsControllerProvider.select((value) => value),
    );
    void open(String key, String? kind) {
      final query = kind == null
          ? ''
          : '?kind=${Uri.encodeQueryComponent(kind)}';
      context.push('/results/${Uri.encodeComponent(key)}$query');
    }

    return usesMacosPresentation()
        ? MacosResultsView(
            controller: controller,
            onOpen: (result) => open(result.key, result.approvalKind),
          )
        : ResultsView(
            controller: controller,
            onOpen: (result) => open(result.key, result.approvalKind),
          );
  }
}

class ProviderBoundResultRoute extends ConsumerWidget {
  const ProviderBoundResultRoute({
    super.key,
    required this.keyValue,
    this.approvalKind,
  });
  final String keyValue;
  final String? approvalKind;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Repository replacement also follows API client replacement and disposal.
    final repository = ref.watch(resultsRepositoryProvider);
    return usesMacosPresentation()
        ? MacosResultDetailView(
            keyValue: keyValue,
            approvalKind: approvalKind,
            repository: repository,
            onOpenInbox: () => context.go('/inbox'),
            onReturnToWork: () => context.go('/projects'),
          )
        : ResultDetailView(
            keyValue: keyValue,
            approvalKind: approvalKind,
            repository: repository,
            onOpenInbox: () => context.go('/inbox'),
            onReturnToWork: () => context.go('/projects'),
          );
  }
}

class ProviderBoundProjectRoute extends ConsumerWidget {
  const ProviderBoundProjectRoute({
    super.key,
    required this.id,
    this.focusWorkItemId,
    this.initiallyBuild = false,
    this.focusArtifactId,
  });
  final String id;
  final String? focusWorkItemId, focusArtifactId;
  final bool initiallyBuild;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final repository = ref.watch(projectsRepositoryProvider);
    final api = ref.watch(apiClientProvider);
    void inspectResult(String key) =>
        context.push('/results/${Uri.encodeComponent(key)}');
    void updateBuilderLocation(bool visible, String? artifact) {
      final query = <String, String>{
        if (visible) 'view': 'build',
        if (visible && artifact != null) 'artifact': artifact,
        'workItemId': ?focusWorkItemId,
      };
      final location =
          '/projects/${Uri.encodeComponent(id)}${query.isEmpty ? '' : '?${Uri(queryParameters: query).query}'}';
      if (GoRouterState.of(context).uri.toString() != location) {
        // A tab selection is a declarative location update. Imperative replace
        // keeps the old URL with GoRouter's default URL reflection setting.
        Router.neglect(context, () => context.go(location));
      }
    }

    return usesMacosPresentation()
        ? MacosProjectDetailView(
            id: id,
            repository: repository,
            api: api,
            focusWorkItemId: focusWorkItemId,
            initiallyBuild: initiallyBuild,
            focusArtifactId: focusArtifactId,
            onBuilderLocationChanged: updateBuilderLocation,
            onInspectResult: inspectResult,
          )
        : ProjectDetailView(
            id: id,
            repository: repository,
            api: api,
            focusWorkItemId: focusWorkItemId,
            initiallyBuild: initiallyBuild,
            focusArtifactId: focusArtifactId,
            onBuilderLocationChanged: updateBuilderLocation,
            onInspectResult: inspectResult,
          );
  }
}

@visibleForTesting
bool isInboxLocation(Uri location) {
  final path = location.path;
  return path == '/inbox' || path.startsWith('/inbox/');
}

@visibleForTesting
String? legacyAutomationRedirect(String path, {bool? macos}) {
  if (!(macos ?? usesMacosPresentation())) return null;
  return switch (path) {
    '/workflows' => '/automation?section=automations',
    '/integrations' => '/automation?section=connections',
    '/tools' => '/automation?section=skills',
    _ => null,
  };
}

/// Keeps a mounted Conversation surface bound to the current authenticated
/// owner's controller instances.
///
/// Selecting the controller values is intentional: the route rebuilds when
/// Riverpod replaces an owner-scoped controller, while ordinary
/// [ChangeNotifier] updates keep selecting the same identity and are ignored.
@visibleForTesting
class ProviderBoundTalkRoute extends ConsumerWidget {
  const ProviderBoundTalkRoute({
    super.key,
    this.quickEntry = false,
    this.ambientVoice = false,
    this.onQuickEntryReady,
    this.onExitQuickEntry,
    this.requestedThreadId,
  });

  final bool quickEntry;
  final bool ambientVoice;
  final VoidCallback? onQuickEntryReady;
  final VoidCallback? onExitQuickEntry;
  final String? requestedThreadId;

  @override
  Widget build(BuildContext context, WidgetRef ref) => TalkView(
    key: ValueKey(ref.watch(companionScopeProvider)),
    controller: ref.watch(
      talkControllerProvider.select((controller) => controller),
    ),
    controllerResolver: () => ref.read(talkControllerProvider),
    localComputer: ref.watch(
      localComputerCoordinatorProvider.select((coordinator) => coordinator),
    ),
    quickEntry: quickEntry,
    ambientVoice: ambientVoice,
    ambientRealtimeFactory: ambientVoice
        ? () => AmbientRealtimeVoiceController(
            api: ref.read(apiClientProvider),
            sessionStore: ref.read(secureSessionStoreProvider),
            onConversationBound: (id) =>
                ref.read(talkControllerProvider).adoptConversationThreadId(id),
          )
        : null,
    ambientConsent: ambientVoice ? _ambientConsent(ref) : null,
    workspaceLocked: ambientVoice
        ? _WorkspaceLocked(
            ref.watch(
              biometricSessionLockControllerProvider.select(
                (controller) => controller,
              ),
            ),
          )
        : null,
    onQuickEntryReady: onQuickEntryReady,
    onExitQuickEntry: onExitQuickEntry,
    onOpenResponsibilities: quickEntry || ambientVoice
        ? null
        : () => context.go('/responsibilities'),
    companionController: ref.watch(
      companionControllerProvider.select((value) => value),
    ),
    requestedThreadId: companionThreadId(requestedThreadId),
    onThreadAdopted: (id) {
      // Same mounted Conversation, retained composer; only adopt confirmed ID.
      if (context.mounted && !quickEntry) context.go('/talk?thread=$id');
    },
  );

  static AmbientVoiceConsent? _ambientConsent(WidgetRef ref) {
    final owner = ref.watch(sessionOwnerKeyProvider);
    if (owner == null) return null;
    return SecureAmbientVoiceConsent(
      ref.read(secureSessionStoreProvider),
      tenantId: owner.tenantId,
      actorId: owner.actorId,
    );
  }
}

/// Whether the owner's workspace is locked, as its lock controller reports.
class _WorkspaceLocked implements ValueListenable<bool> {
  const _WorkspaceLocked(this.lock);

  final BiometricSessionLockController lock;

  @override
  bool get value => lock.state.blocksInteraction;

  @override
  void addListener(VoidCallback listener) => lock.addListener(listener);

  @override
  void removeListener(VoidCallback listener) => lock.removeListener(listener);

  @override
  bool operator ==(Object other) =>
      other is _WorkspaceLocked && identical(other.lock, lock);

  @override
  int get hashCode => identityHashCode(lock);
}

final appRouterProvider = Provider<GoRouter>((ref) {
  final session = ref.watch(sessionControllerProvider);
  final initialLocation = ref.watch(appInitialLocationProvider);
  final explicitEntry = ref.watch(appExplicitInitialLocationProvider);
  final entryLocation = explicitEntry ? initialLocation : '/companion-entry';
  final homePath = entryLocation;
  final reconnect = ref.read(reconnectCoordinatorProvider);
  final entryIntent = ref.read(_entryIntentProvider);
  late final GoRouter router;
  void syncActiveFreshnessScope() {
    reconnect.setActiveFreshnessScope(
      router.routerDelegate.currentConfiguration.uri.path,
    );
  }

  router = GoRouter(
    debugLogDiagnostics: kDebugMode,
    initialLocation: entryLocation,
    onEnter: (_, _, nextState, _) {
      if (!session.isLoading &&
          !session.hasError &&
          session.value != null &&
          isInboxLocation(nextState.uri)) {
        unawaited(ref.read(inboxControllerProvider).refresh());
      }
      return const Allow();
    },
    redirect: (context, state) {
      final atLogin = state.matchedLocation == '/login';
      final atBootstrap = state.matchedLocation == '/bootstrap';
      if (session.isLoading || session.hasError) {
        if (!entryIntent.hadSession) entryIntent.remember(state.uri.toString());
        return atBootstrap ? null : '/bootstrap';
      }
      if (session.value == null) {
        if (!entryIntent.hadSession) {
          entryIntent.remember(state.uri.toString());
        } else {
          entryIntent.location = null;
        }
        entryIntent.hadSession = false;
        return atLogin ? null : '/login';
      }
      entryIntent.hadSession = true;
      if (atLogin || atBootstrap) return entryIntent.take() ?? homePath;
      return null;
    },
    routes: [
      GoRoute(
        path: '/companion-entry',
        builder: (_, _) => CompanionDefaultEntry(
          key: ValueKey(ref.watch(companionScopeProvider)),
          fallback: appHomePath(),
        ),
      ),
      GoRoute(path: '/login', builder: (_, _) => const LoginScreen()),
      GoRoute(
        path: '/bootstrap',
        builder: (_, _) => const SessionBootstrapScreen(),
      ),
      GoRoute(
        path: '/administration',
        redirect: (_, _) => usesMacosPresentation() ? '/monitoring' : null,
        builder: (_, _) => const AdminConsole(),
      ),
      GoRoute(
        path: '/devices',
        builder: (_, _) => const DeviceSecurityScreen(),
      ),
      GoRoute(
        path: '/quick-entry',
        builder: (context, _) => ProviderBoundTalkRoute(
          quickEntry: true,
          onQuickEntryReady: () {
            unawaited(appDesktopHostBridge.showQuickEntryPresentation());
          },
          onExitQuickEntry: () {
            final router = GoRouter.of(context);
            if (router.canPop()) {
              router.pop();
            } else {
              router.go('/talk');
            }
            WidgetsBinding.instance.addPostFrameCallback((_) {
              unawaited(appDesktopHostBridge.showMainPresentation());
            });
          },
        ),
      ),
      GoRoute(
        path: '/ambient-voice',
        builder: (context, _) => ProviderBoundTalkRoute(
          quickEntry: true,
          ambientVoice: true,
          onQuickEntryReady: () {
            unawaited(appDesktopHostBridge.showAmbientVoicePresentation());
          },
          onExitQuickEntry: () {
            final router = GoRouter.of(context);
            if (router.canPop()) {
              router.pop();
            } else {
              router.go('/talk');
            }
            WidgetsBinding.instance.addPostFrameCallback((_) {
              unawaited(appDesktopHostBridge.showMainPresentation());
            });
          },
        ),
      ),
      GoRoute(path: '/missions', redirect: (_, _) => '/projects'),
      GoRoute(path: '/missions/:id', redirect: (_, _) => '/projects'),
      GoRoute(
        path: '/customers/:id',
        builder: (_, state) =>
            ProviderBoundAccountsRoute(id: state.pathParameters['id']!),
      ),
      StatefulShellRoute.indexedStack(
        builder: (_, _, shell) => AdaptiveShell(navigationShell: shell),
        branches: [
          for (final destination in appDestinations)
            StatefulShellBranch(
              routes: [
                GoRoute(
                  path: destination.path,
                  redirect: (_, _) =>
                      legacyAutomationRedirect(destination.path),
                  builder: (context, state) => switch (destination.path) {
                    '/today' =>
                      usesMacosPresentation()
                          ? MacosTodayView(
                              controller: ref.read(todayControllerProvider),
                              focusItemId:
                                  state.uri.queryParameters['workItemId'],
                            )
                          : TodayView(
                              controller: ref.read(todayControllerProvider),
                              focusItemId:
                                  state.uri.queryParameters['workItemId'],
                            ),
                    '/talk' => ProviderBoundTalkRoute(
                      requestedThreadId: state.uri.queryParameters['thread'],
                    ),
                    '/activity' => const ProviderBoundActivityRoute(),
                    '/responsibilities' =>
                      const ProviderBoundResponsibilityRoute(),
                    '/capture' => const ProviderBoundCaptureRoute(),
                    '/projects' => const ProviderBoundProjectsRoute(),
                    '/meetings' => const ProviderBoundMeetingsRoute(),
                    '/results' => const ProviderBoundResultsRoute(),
                    '/inbox' =>
                      usesMacosPresentation()
                          ? MacosInboxView(
                              controller: ref.read(inboxControllerProvider),
                              onOpenResponsibility: (id) =>
                                  _openResponsibility(context, id),
                            )
                          : InboxView(
                              controller: ref.read(inboxControllerProvider),
                              onOpenResponsibility: (id) =>
                                  _openResponsibility(context, id),
                            ),
                    '/agents' =>
                      usesMacosPresentation()
                          ? MacosAgentsView(
                              controller: ref.read(agentsControllerProvider),
                              councilController: ref.read(
                                agentCouncilControllerProvider,
                              ),
                              onAssignWork: (agent) {
                                final talk = ref.read(talkControllerProvider);
                                if (talk.hasPendingConversationWork) {
                                  ScaffoldMessenger.of(context).showSnackBar(
                                    const SnackBar(
                                      content: Text(
                                        'Finish, stop, or clear pending Conversation work before assigning another Agent.',
                                      ),
                                    ),
                                  );
                                  return;
                                }
                                talk.newConversation();
                                talk.assignAgent(
                                  id: agent.id,
                                  name: agent.name,
                                );
                                context.go('/talk');
                              },
                            )
                          : AgentsView(
                              controller: ref.read(agentsControllerProvider),
                              liveWork: AgentControlView(
                                controller: ref.read(
                                  agentCouncilControllerProvider,
                                ),
                              ),
                              onRefreshLiveWork: ref
                                  .read(agentCouncilControllerProvider)
                                  .refresh,
                            ),
                    '/knowledge' => ProviderBoundKnowledgeRoute(
                      initialMemoryId: state.uri.queryParameters['memory'],
                    ),
                    '/accounts' => const ProviderBoundAccountsRoute(),
                    '/markets' => MarketsView(api: ref.read(apiClientProvider)),
                    '/payments' =>
                      usesMacosPresentation()
                          ? MacosPaymentsView(api: ref.read(apiClientProvider))
                          : PaymentsView(api: ref.read(apiClientProvider)),
                    '/automation' =>
                      usesMacosPresentation()
                          ? MacosAutomationStudioView(
                              initialSection:
                                  state.uri.queryParameters['section'],
                            )
                          : AutomationStudioView(
                              initialSection:
                                  state.uri.queryParameters['section'],
                            ),
                    '/workflows' =>
                      usesMacosPresentation()
                          ? const MacosAdminWorkspaceView(
                              moduleId: 'automation',
                            )
                          : const AdminWorkspaceView(moduleId: 'automation'),
                    '/integrations' =>
                      usesMacosPresentation()
                          ? const MacosAdminWorkspaceView(
                              moduleId: 'integrations',
                            )
                          : const AdminWorkspaceView(moduleId: 'integrations'),
                    '/tools' =>
                      usesMacosPresentation()
                          ? const MacosAdminWorkspaceView(moduleId: 'tools')
                          : const AdminWorkspaceView(moduleId: 'tools'),
                    '/quality' =>
                      usesMacosPresentation()
                          ? const MacosAdminWorkspaceView(moduleId: 'quality')
                          : const AdminWorkspaceView(moduleId: 'quality'),
                    '/monitoring' =>
                      usesMacosPresentation()
                          ? const MacosAdminWorkspaceView(
                              moduleId: 'monitoring',
                            )
                          : const AdminWorkspaceView(moduleId: 'monitoring'),
                    '/security' =>
                      usesMacosPresentation()
                          ? const MacosAdminWorkspaceView(moduleId: 'security')
                          : const AdminWorkspaceView(moduleId: 'security'),
                    '/settings' => ModelSettingsView(
                      api: ref.read(apiClientProvider),
                    ),
                    _ => DestinationPlaceholder(destination: destination),
                  },
                  routes: destination.path == '/accounts'
                      ? [
                          GoRoute(
                            path: ':id',
                            builder: (_, state) => ProviderBoundAccountsRoute(
                              id: state.pathParameters['id']!,
                            ),
                          ),
                        ]
                      : destination.path == '/projects'
                      ? [
                          GoRoute(
                            path: ':id',
                            builder: (_, state) => ProviderBoundProjectRoute(
                              id: state.pathParameters['id']!,
                              focusWorkItemId:
                                  state.uri.queryParameters['workItemId'],
                              initiallyBuild:
                                  state.uri.queryParameters['view'] == 'build',
                              focusArtifactId:
                                  state.uri.queryParameters['artifact'],
                            ),
                          ),
                        ]
                      : destination.path == '/results'
                      ? [
                          GoRoute(
                            path: ':key',
                            builder: (_, state) => ProviderBoundResultRoute(
                              keyValue: state.pathParameters['key']!,
                              approvalKind: state.uri.queryParameters['kind'],
                            ),
                          ),
                        ]
                      : destination.path == '/responsibilities'
                      ? [
                          GoRoute(
                            path: ':id',
                            builder: (_, state) =>
                                ProviderBoundResponsibilityRoute(
                                  focusId: state.pathParameters['id']!,
                                ),
                          ),
                        ]
                      : destination.path == '/meetings'
                      ? [
                          GoRoute(
                            path: ':id',
                            builder: (_, state) => ProviderBoundMeetingRoute(
                              id: state.pathParameters['id']!,
                            ),
                          ),
                        ]
                      : destination.path == '/inbox'
                      ? [
                          GoRoute(
                            path: 'approvals/:id',
                            builder: (context, state) => usesMacosPresentation()
                                ? MacosInboxView(
                                    controller: ref.read(
                                      inboxControllerProvider,
                                    ),
                                    focusApprovalId: state.pathParameters['id'],
                                    focusApprovalKind:
                                        state.uri.queryParameters['kind'],
                                    onOpenResponsibility: (id) =>
                                        _openResponsibility(context, id),
                                  )
                                : InboxView(
                                    controller: ref.read(
                                      inboxControllerProvider,
                                    ),
                                    focusApprovalId: state.pathParameters['id'],
                                    focusApprovalKind:
                                        state.uri.queryParameters['kind'],
                                    onOpenResponsibility: (id) =>
                                        _openResponsibility(context, id),
                                  ),
                          ),
                        ]
                      : const [],
                ),
              ],
            ),
        ],
      ),
    ],
  );
  syncActiveFreshnessScope();
  router.routerDelegate.addListener(syncActiveFreshnessScope);
  ref.onDispose(() {
    router.routerDelegate.removeListener(syncActiveFreshnessScope);
    router.dispose();
  });
  return router;
});
