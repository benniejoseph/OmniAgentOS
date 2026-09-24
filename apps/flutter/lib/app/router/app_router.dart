import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/network/api_client.dart';
import '../../core/platform/desktop_host_bridge.dart';
import '../../core/storage/secure_session_store.dart';
import '../../features/ambient_voice/realtime_voice_controller.dart';
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
import '../../features/customers/accounts_view.dart';
import '../../features/customers/customer_detail.dart';
import '../../features/customers/macos_accounts_view.dart';
import '../../features/customers/macos_customer_detail_view.dart';
import '../../features/inbox/macos_inbox_view.dart';
import '../../features/inbox/inbox.dart';
import '../../features/inbox/inbox_providers.dart';
import '../../features/knowledge/knowledge.dart';
import '../../features/knowledge/macos_knowledge_view.dart';
import '../../features/knowledge/knowledge_providers.dart';
import '../../features/markets/markets_view.dart';
import '../../features/payments/macos_payments_view.dart';
import '../../features/payments/payments_view.dart';
import '../../features/meetings/macos_meetings_view.dart';
import '../../features/meetings/macos_meeting_detail_view.dart';
import '../../features/meetings/meetings_providers.dart';
import '../../features/meetings/meetings_view.dart';
import '../../features/projects/macos_project_detail_view.dart';
import '../../features/projects/projects_providers.dart';
import '../../features/projects/macos_projects_view.dart';
import '../../features/projects/projects_view.dart';
import '../../features/results/macos_result_detail_view.dart';
import '../../features/results/results_providers.dart';
import '../../features/results/macos_results_view.dart';
import '../../features/results/results_view.dart';
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

String initialAppLocation(List<String> arguments) {
  const prefix = '--asael-route=';
  final route = arguments
      .where((argument) => argument.startsWith(prefix))
      .map((argument) => argument.substring(prefix.length))
      .lastOrNull;
  return route != null && DesktopHostBridge.isWorkspaceRoute(route)
      ? route
      : appHomePath();
}

final appInitialLocationProvider = Provider<String>((_) => appHomePath());

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
  });

  final bool quickEntry;
  final bool ambientVoice;
  final VoidCallback? onQuickEntryReady;
  final VoidCallback? onExitQuickEntry;

  @override
  Widget build(BuildContext context, WidgetRef ref) => TalkView(
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
    onQuickEntryReady: onQuickEntryReady,
    onExitQuickEntry: onExitQuickEntry,
  );
}

final appRouterProvider = Provider<GoRouter>((ref) {
  final session = ref.watch(sessionControllerProvider);
  final initialLocation = ref.watch(appInitialLocationProvider);
  final homePath = initialLocation;
  return GoRouter(
    debugLogDiagnostics: kDebugMode,
    initialLocation: initialLocation,
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
        return atBootstrap ? null : '/bootstrap';
      }
      if (session.value == null) return atLogin ? null : '/login';
      if (atLogin || atBootstrap) return homePath;
      return null;
    },
    routes: [
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
      GoRoute(path: '/missions', redirect: (_, _) => '/projects'),
      GoRoute(path: '/missions/:id', redirect: (_, _) => '/projects'),
      GoRoute(
        path: '/customers/:id',
        builder: (_, state) => usesMacosPresentation()
            ? MacosCustomerDetailView(
                id: state.pathParameters['id']!,
                api: ref.read(apiClientProvider),
              )
            : CustomerDetailView(
                id: state.pathParameters['id']!,
                api: ref.read(apiClientProvider),
              ),
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
                    '/talk' => const ProviderBoundTalkRoute(),
                    '/capture' => CaptureView(
                      controller: ref.read(captureControllerProvider),
                    ),
                    '/projects' =>
                      usesMacosPresentation()
                          ? MacosProjectsView(
                              controller: ref.read(projectsControllerProvider),
                              onOpen: (project) =>
                                  context.push('/projects/${project.id}'),
                            )
                          : ProjectsView(
                              controller: ref.read(projectsControllerProvider),
                              onOpen: (project) =>
                                  context.push('/projects/${project.id}'),
                            ),
                    '/meetings' =>
                      usesMacosPresentation()
                          ? MacosMeetingsView(
                              controller: ref.read(meetingsControllerProvider),
                              onOpen: (meeting) =>
                                  context.push('/meetings/${meeting.id}'),
                            )
                          : MeetingsView(
                              controller: ref.read(meetingsControllerProvider),
                              onOpen: (meeting) =>
                                  context.push('/meetings/${meeting.id}'),
                            ),
                    '/results' =>
                      usesMacosPresentation()
                          ? MacosResultsView(
                              controller: ref.read(resultsControllerProvider),
                              onOpen: (result) => context.push(
                                '/results/${Uri.encodeComponent(result.key)}',
                              ),
                            )
                          : ResultsView(
                              controller: ref.read(resultsControllerProvider),
                              onOpen: (result) => context.push(
                                '/results/${Uri.encodeComponent(result.key)}',
                              ),
                            ),
                    '/inbox' =>
                      usesMacosPresentation()
                          ? MacosInboxView(
                              controller: ref.read(inboxControllerProvider),
                            )
                          : InboxView(
                              controller: ref.read(inboxControllerProvider),
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
                    '/knowledge' =>
                      usesMacosPresentation()
                          ? MacosKnowledgeView(
                              controller: ref.read(knowledgeControllerProvider),
                            )
                          : KnowledgeView(
                              controller: ref.read(knowledgeControllerProvider),
                            ),
                    '/accounts' =>
                      usesMacosPresentation()
                          ? MacosAccountsView(
                              api: ref.read(apiClientProvider),
                              onOpen: (account) =>
                                  context.push('/accounts/${account.id}'),
                            )
                          : AccountsView(
                              api: ref.read(apiClientProvider),
                              onOpen: (account) =>
                                  context.push('/accounts/${account.id}'),
                            ),
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
                            builder: (_, state) => usesMacosPresentation()
                                ? MacosCustomerDetailView(
                                    id: state.pathParameters['id']!,
                                    api: ref.read(apiClientProvider),
                                  )
                                : CustomerDetailView(
                                    id: state.pathParameters['id']!,
                                    api: ref.read(apiClientProvider),
                                  ),
                          ),
                        ]
                      : destination.path == '/projects'
                      ? [
                          GoRoute(
                            path: ':id',
                            builder: (_, state) => usesMacosPresentation()
                                ? MacosProjectDetailView(
                                    id: state.pathParameters['id']!,
                                    repository: ref.read(
                                      projectsRepositoryProvider,
                                    ),
                                    api: ref.read(apiClientProvider),
                                    focusWorkItemId:
                                        state.uri.queryParameters['workItemId'],
                                  )
                                : ProjectDetailView(
                                    id: state.pathParameters['id']!,
                                    repository: ref.read(
                                      projectsRepositoryProvider,
                                    ),
                                    api: ref.read(apiClientProvider),
                                    focusWorkItemId:
                                        state.uri.queryParameters['workItemId'],
                                  ),
                          ),
                        ]
                      : destination.path == '/results'
                      ? [
                          GoRoute(
                            path: ':key',
                            builder: (_, state) => usesMacosPresentation()
                                ? MacosResultDetailView(
                                    keyValue: Uri.decodeComponent(
                                      state.pathParameters['key']!,
                                    ),
                                    repository: ref.read(
                                      resultsRepositoryProvider,
                                    ),
                                  )
                                : ResultDetailView(
                                    keyValue: Uri.decodeComponent(
                                      state.pathParameters['key']!,
                                    ),
                                    repository: ref.read(
                                      resultsRepositoryProvider,
                                    ),
                                  ),
                          ),
                        ]
                      : destination.path == '/meetings'
                      ? [
                          GoRoute(
                            path: ':id',
                            builder: (_, state) => usesMacosPresentation()
                                ? MacosMeetingDetailView(
                                    id: state.pathParameters['id']!,
                                    repository: ref.read(
                                      meetingsRepositoryProvider,
                                    ),
                                  )
                                : MeetingDetailView(
                                    id: state.pathParameters['id']!,
                                    repository: ref.read(
                                      meetingsRepositoryProvider,
                                    ),
                                  ),
                          ),
                        ]
                      : destination.path == '/inbox'
                      ? [
                          GoRoute(
                            path: 'approvals/:id',
                            builder: (_, state) => usesMacosPresentation()
                                ? MacosInboxView(
                                    controller: ref.read(
                                      inboxControllerProvider,
                                    ),
                                    focusApprovalId: state.pathParameters['id'],
                                  )
                                : InboxView(
                                    controller: ref.read(
                                      inboxControllerProvider,
                                    ),
                                    focusApprovalId: state.pathParameters['id'],
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
});
