import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/network/api_client.dart';
import '../../core/platform/desktop_host_bridge.dart';
import '../../features/auth/application/session_controller.dart';
import '../../features/auth/presentation/login_screen.dart';
import '../../features/auth/presentation/session_bootstrap_screen.dart';
import '../../features/agents/agents.dart';
import '../../features/agents/agents_providers.dart';
import '../../features/capture/capture.dart';
import '../../features/capture/capture_providers.dart';
import '../../features/customers/customer_detail.dart';
import '../../features/customers/accounts_view.dart';
import '../../features/inbox/inbox.dart';
import '../../features/inbox/inbox_providers.dart';
import '../../features/knowledge/knowledge.dart';
import '../../features/knowledge/knowledge_providers.dart';
import '../../features/markets/markets_view.dart';
import '../../features/payments/payments_view.dart';
import '../../features/meetings/meetings_providers.dart';
import '../../features/meetings/meetings_view.dart';
import '../../features/projects/projects_providers.dart';
import '../../features/projects/projects_view.dart';
import '../../features/results/results_providers.dart';
import '../../features/results/results_view.dart';
import '../../features/settings/admin_console.dart';
import '../../features/settings/model_settings_view.dart';
import '../../features/security/device_security_screen.dart';
import '../../features/talk/talk.dart';
import '../../features/talk/talk_providers.dart';
import '../../features/today/today.dart';
import '../../features/today/today_providers.dart';
import '../navigation/adaptive_shell.dart';
import '../navigation/app_destination.dart';
import '../navigation/destination_placeholder.dart';

String appHomePath() => !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS
    ? '/talk'
    : '/today';

final appRouterProvider = Provider<GoRouter>((ref) {
  final session = ref.watch(sessionControllerProvider);
  final homePath = appHomePath();
  return GoRouter(
    initialLocation: homePath,
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
      GoRoute(path: '/administration', builder: (_, _) => const AdminConsole()),
      GoRoute(
        path: '/devices',
        builder: (_, _) => const DeviceSecurityScreen(),
      ),
      GoRoute(
        path: '/quick-entry',
        builder: (context, _) => TalkView(
          controller: ref.watch(talkControllerProvider),
          quickEntry: true,
          onExitQuickEntry: () {
            unawaited(appDesktopHostBridge.showMainPresentation());
            context.go('/talk');
          },
        ),
      ),
      GoRoute(path: '/missions', redirect: (_, _) => '/projects'),
      GoRoute(path: '/missions/:id', redirect: (_, _) => '/projects'),
      GoRoute(
        path: '/customers/:id',
        builder: (_, state) => CustomerDetailView(
          id: state.pathParameters['id']!,
          api: ref.watch(apiClientProvider),
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
                  builder: (context, state) => switch (destination.path) {
                    '/today' => TodayView(
                      controller: ref.watch(todayControllerProvider),
                      focusItemId: state.uri.queryParameters['workItemId'],
                    ),
                    '/talk' => TalkView(
                      controller: ref.watch(talkControllerProvider),
                    ),
                    '/capture' => CaptureView(
                      controller: ref.watch(captureControllerProvider),
                    ),
                    '/projects' => ProjectsView(
                      controller: ref.watch(projectsControllerProvider),
                      onOpen: (project) =>
                          context.push('/projects/${project.id}'),
                    ),
                    '/meetings' => MeetingsView(
                      controller: ref.watch(meetingsControllerProvider),
                      onOpen: (meeting) =>
                          context.push('/meetings/${meeting.id}'),
                    ),
                    '/results' => ResultsView(
                      controller: ref.watch(resultsControllerProvider),
                      onOpen: (result) => context.push(
                        '/results/${Uri.encodeComponent(result.key)}',
                      ),
                    ),
                    '/inbox' => InboxView(
                      controller: ref.watch(inboxControllerProvider),
                    ),
                    '/agents' => AgentsView(
                      controller: ref.watch(agentsControllerProvider),
                    ),
                    '/knowledge' => KnowledgeView(
                      controller: ref.watch(knowledgeControllerProvider),
                    ),
                    '/accounts' => AccountsView(
                      api: ref.watch(apiClientProvider),
                      onOpen: (account) =>
                          context.push('/accounts/${account.id}'),
                    ),
                    '/markets' => MarketsView(
                      api: ref.watch(apiClientProvider),
                    ),
                    '/payments' => PaymentsView(
                      api: ref.watch(apiClientProvider),
                    ),
                    '/workflows' => const AdminWorkspaceView(
                      moduleId: 'automation',
                    ),
                    '/integrations' => const AdminWorkspaceView(
                      moduleId: 'integrations',
                    ),
                    '/tools' => const AdminWorkspaceView(moduleId: 'tools'),
                    '/quality' => const AdminWorkspaceView(moduleId: 'quality'),
                    '/monitoring' => const AdminWorkspaceView(
                      moduleId: 'monitoring',
                    ),
                    '/security' => const AdminWorkspaceView(
                      moduleId: 'security',
                    ),
                    '/settings' => ModelSettingsView(
                      api: ref.watch(apiClientProvider),
                    ),
                    _ => DestinationPlaceholder(destination: destination),
                  },
                  routes: destination.path == '/accounts'
                      ? [
                          GoRoute(
                            path: ':id',
                            builder: (_, state) => CustomerDetailView(
                              id: state.pathParameters['id']!,
                              api: ref.watch(apiClientProvider),
                            ),
                          ),
                        ]
                      : destination.path == '/projects'
                      ? [
                          GoRoute(
                            path: ':id',
                            builder: (_, state) => ProjectDetailView(
                              id: state.pathParameters['id']!,
                              repository: ref.watch(projectsRepositoryProvider),
                              api: ref.watch(apiClientProvider),
                              focusWorkItemId:
                                  state.uri.queryParameters['workItemId'],
                            ),
                          ),
                        ]
                      : destination.path == '/results'
                      ? [
                          GoRoute(
                            path: ':key',
                            builder: (_, state) => ResultDetailView(
                              keyValue: Uri.decodeComponent(
                                state.pathParameters['key']!,
                              ),
                              repository: ref.watch(resultsRepositoryProvider),
                            ),
                          ),
                        ]
                      : destination.path == '/meetings'
                      ? [
                          GoRoute(
                            path: ':id',
                            builder: (_, state) => MeetingDetailView(
                              id: state.pathParameters['id']!,
                              repository: ref.watch(meetingsRepositoryProvider),
                            ),
                          ),
                        ]
                      : destination.path == '/inbox'
                      ? [
                          GoRoute(
                            path: 'approvals/:id',
                            builder: (_, state) => InboxView(
                              controller: ref.watch(inboxControllerProvider),
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
