import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'package:asael/app/mobile/mobile_page_scaffold.dart';
import 'package:asael/app/navigation/mobile_library_page.dart';
import 'package:asael/app/theme/mobile_app_theme.dart';

/// Local visual preview only. No app bootstrap, session, provider, repository,
/// native bridge, microphone or network client is included in this entrypoint.
void main() {
  FlutterError.onError = (details) {
    FlutterError.presentError(details);
    if (kDebugMode) {
      debugPrint('MOBILE DESIGN PREVIEW: ${details.exceptionAsString()}');
      if (details.stack != null) debugPrintStack(stackTrace: details.stack);
    }
  };
  runApp(const MobileDesignPreview());
}

Map<String, String> _previewParameters() {
  final fragment = Uri.tryParse(Uri.base.fragment);
  return {
    ...Uri.base.queryParameters,
    if (fragment != null) ...fragment.queryParameters,
  };
}

class MobileDesignPreview extends StatefulWidget {
  const MobileDesignPreview({super.key});

  @override
  State<MobileDesignPreview> createState() => _MobileDesignPreviewState();
}

class _MobileDesignPreviewState extends State<MobileDesignPreview> {
  late final Map<String, String> _parameters = _previewParameters();
  late bool _dark = _parameters['theme'] == 'dark';
  late bool _largeText = _parameters['scale'] == '1.5';
  late final bool _showControls = _parameters['controls'] != '0';

  String get _initialPage => switch (_parameters['page']) {
    'settings' => '/preview/settings',
    'conversation' || 'assistant' => '/preview/conversation',
    'states' => '/preview/states',
    _ => '/library',
  };
  late final GoRouter _router = GoRouter(
    initialLocation: _initialPage,
    overridePlatformDefaultLocation: true,
    routes: [
      GoRoute(path: '/', redirect: (_, _) => '/library'),
      GoRoute(path: '/library', builder: (_, _) => const MobileLibraryPage()),
      GoRoute(
        path: '/preview/settings',
        builder: (_, _) => const _SampleSettings(),
      ),
      GoRoute(
        path: '/preview/conversation',
        builder: (_, _) => const _SampleConversation(),
      ),
      GoRoute(
        path: '/preview/states',
        builder: (_, _) => const _SampleStates(),
      ),
      GoRoute(
        path: '/:feature',
        builder: (_, state) => _PreviewPlaceholder(
          feature: state.pathParameters['feature'] ?? 'Feature',
        ),
      ),
    ],
    errorBuilder: (_, _) => const _PreviewPlaceholder(feature: 'Feature'),
  );

  @override
  void dispose() {
    _router.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp.router(
    title: 'Asael mobile design preview',
    debugShowCheckedModeBanner: false,
    theme: MobileAppTheme.light(),
    darkTheme: MobileAppTheme.dark(),
    themeMode: _dark ? ThemeMode.dark : ThemeMode.light,
    themeAnimationDuration: Duration.zero,
    routerConfig: _router,
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(context).copyWith(
        textScaler: TextScaler.linear(_largeText ? 1.5 : 1),
        disableAnimations: true,
      ),
      child: Scaffold(
        body: SafeArea(
          child: Column(
            children: [
              // A wrapping preview toolbar avoids AppBar action/title layout
              // assumptions at narrow widths and large accessibility text.
              if (_showControls)
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 8, 12, 8),
                  child: Wrap(
                    spacing: 8,
                    runSpacing: 4,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      const Text(
                        'Design preview',
                        style: TextStyle(fontSize: 14),
                      ),
                      TextButton.icon(
                        onPressed: () => setState(() => _dark = !_dark),
                        icon: Icon(
                          _dark
                              ? Icons.light_mode_outlined
                              : Icons.dark_mode_outlined,
                          size: 18,
                        ),
                        label: Text(_dark ? 'Light' : 'Dark'),
                      ),
                      TextButton(
                        onPressed: () =>
                            setState(() => _largeText = !_largeText),
                        child: Text(_largeText ? 'Text 1.5×' : 'Text 1×'),
                      ),
                    ],
                  ),
                )
              else
                const Padding(
                  padding: EdgeInsets.fromLTRB(20, 8, 20, 0),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      'Design preview',
                      style: TextStyle(fontSize: 12),
                    ),
                  ),
                ),
              if (_showControls)
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
                  child: ListenableBuilder(
                    listenable: _router.routeInformationProvider,
                    builder: (_, _) => MobileSegmentBar<String>(
                      items: const [
                        (
                          value: '/library',
                          label: 'Library',
                          icon: Icons.widgets_outlined,
                        ),
                        (
                          value: '/preview/settings',
                          label: 'Settings',
                          icon: Icons.tune_rounded,
                        ),
                        (
                          value: '/preview/conversation',
                          label: 'Assistant',
                          icon: Icons.chat_bubble_outline_rounded,
                        ),
                        (
                          value: '/preview/states',
                          label: 'States',
                          icon: Icons.layers_outlined,
                        ),
                      ],
                      value: _router.routeInformationProvider.value.uri.path,
                      onChanged: _router.go,
                    ),
                  ),
                ),
              Expanded(child: child ?? const SizedBox.shrink()),
            ],
          ),
        ),
      ),
    ),
  );
}

class _SampleSettings extends StatelessWidget {
  const _SampleSettings();

  @override
  Widget build(BuildContext context) => ListView(
    children: [
      const MobilePageHeader(
        title: 'Settings',
        subtitle: 'Preview · sample content',
      ),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20),
        child: MobileSurface(
          spotlight: true,
          child: Builder(
            builder: (context) => Row(
              children: [
                const Icon(Icons.face_retouching_natural_outlined, size: 46),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'ATLAS, your way',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      const SizedBox(height: 6),
                      const Text('A familiar voice. A little personality.'),
                      const SizedBox(height: 12),
                      const MobileStatusPill(
                        label: 'Sample preference',
                        icon: Icons.tune_rounded,
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
      const MobileSectionHeader(title: 'Every day'),
      _PreviewGroup(
        children: [
          _sampleTile(
            context,
            Icons.face_retouching_natural_outlined,
            'ATLAS & voice',
            'Appearance and personality',
          ),
          _sampleTile(
            context,
            Icons.person_outline_rounded,
            'About me',
            'What you want ATLAS to know',
          ),
          _sampleTile(
            context,
            Icons.nightlight_outlined,
            'Nightly call notes',
            'Recorded calls and daily schedule',
          ),
        ],
      ),
      const MobileSectionHeader(title: 'Privacy & access'),
      _PreviewGroup(
        children: [
          _sampleTile(
            context,
            Icons.devices_rounded,
            'Devices & app lock',
            'Sign-ins and local unlock',
          ),
          _sampleTile(
            context,
            Icons.shield_outlined,
            'Security',
            'Access, data and decisions',
          ),
          _sampleTile(
            context,
            Icons.inventory_2_outlined,
            'Your data',
            'Export and portable archives',
          ),
        ],
      ),
      const SizedBox(height: 24),
    ],
  );

  Widget _sampleTile(
    BuildContext context,
    IconData icon,
    String title,
    String subtitle,
  ) => MobileActionTile(
    icon: icon,
    title: title,
    subtitle: subtitle,
    onTap: () => context.push('/sample'),
  );
}

class _PreviewGroup extends StatelessWidget {
  const _PreviewGroup({required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 20),
    child: MobileSurface(
      padding: EdgeInsets.zero,
      child: Column(
        children: [
          for (final (index, child) in children.indexed) ...[
            if (index > 0) const Divider(height: 1, indent: 76, endIndent: 16),
            child,
          ],
        ],
      ),
    ),
  );
}

class _SampleConversation extends StatelessWidget {
  const _SampleConversation();

  @override
  Widget build(BuildContext context) => Column(
    children: [
      const MobilePageHeader(
        title: 'Assistant',
        subtitle: 'Preview · sample transcript',
      ),
      Expanded(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
          children: [
            Align(
              alignment: Alignment.centerRight,
              child: Container(
                constraints: BoxConstraints(
                  maxWidth: MediaQuery.sizeOf(context).width * .8,
                ),
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.secondaryContainer,
                  borderRadius: BorderRadius.circular(16),
                ),
                child: const Text(
                  'Help me turn these meeting notes into a clear plan.',
                ),
              ),
            ),
            const SizedBox(height: 24),
            const MobileStatusPill(
              label: 'ATLAS · example reply',
              icon: Icons.auto_awesome_outlined,
            ),
            const SizedBox(height: 12),
            const Text(
              'Certainly. Start with the customer’s goal, then collect what is known, what needs a decision and who will follow up.',
            ),
            const SizedBox(height: 16),
            const MobileSurface(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Sample next steps',
                    style: TextStyle(fontWeight: FontWeight.w600),
                  ),
                  SizedBox(height: 12),
                  Text('1. Confirm the outcome that matters most.'),
                  SizedBox(height: 10),
                  Text('2. Bring the open questions to the next conversation.'),
                  SizedBox(height: 10),
                  Text('3. Agree on an owner for each follow-up.'),
                ],
              ),
            ),
            const SizedBox(height: 16),
            const Text(
              'This is static sample text. Nothing is sent or saved.',
              style: TextStyle(fontSize: 13),
            ),
          ],
        ),
      ),
      const Padding(
        padding: EdgeInsets.fromLTRB(20, 12, 20, 20),
        child: TextField(
          enabled: false,
          decoration: InputDecoration(
            hintText: 'Preview only · composer disabled',
            prefixIcon: Icon(Icons.add_rounded),
            suffixIcon: Icon(Icons.arrow_upward_rounded),
          ),
        ),
      ),
    ],
  );
}

class _SampleStates extends StatefulWidget {
  const _SampleStates();
  @override
  State<_SampleStates> createState() => _SampleStatesState();
}

class _SampleStatesState extends State<_SampleStates> {
  String _selected = 'empty';

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.fromLTRB(20, 20, 20, 32),
    children: [
      Text('Content states', style: Theme.of(context).textTheme.headlineMedium),
      const SizedBox(height: 6),
      const Text('Preview · simulated states only'),
      const SizedBox(height: 20),
      MobileSegmentBar<String>(
        items: const [
          (value: 'empty', label: 'Empty', icon: Icons.inbox_outlined),
          (
            value: 'unavailable',
            label: 'Unavailable',
            icon: Icons.cloud_off_outlined,
          ),
          (value: 'long', label: 'Long content', icon: Icons.notes_rounded),
        ],
        value: _selected,
        onChanged: (value) => setState(() => _selected = value),
      ),
      const SizedBox(height: 20),
      MobileSurface(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            MobileStatusPill(
              label: switch (_selected) {
                'unavailable' => 'Sample unavailable state',
                'long' => 'Sample long content',
                _ => 'Sample empty state',
              },
              icon: _selected == 'unavailable'
                  ? Icons.cloud_off_outlined
                  : Icons.info_outline_rounded,
            ),
            const SizedBox(height: 20),
            Text(switch (_selected) {
              'unavailable' => 'This source could not be reached. Its current contents are unknown.',
              'long' => 'A deliberately long customer follow-up title that should remain readable when the phone is narrow and the text size is increased',
              _ => 'Nothing is waiting here',
            }, style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 12),
            Text(
              _selected == 'empty'
                  ? 'Items will appear as you add them. This empty state does not describe your real workspace.'
                  : 'The preview keeps the full wording visible. These examples do not connect to any account, service or device.',
            ),
          ],
        ),
      ),
    ],
  );
}

class _PreviewPlaceholder extends StatelessWidget {
  const _PreviewPlaceholder({required this.feature});
  final String feature;

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(20),
    children: [
      const MobileStatusPill(
        label: 'Design preview',
        icon: Icons.visibility_outlined,
      ),
      const SizedBox(height: 24),
      Text(
        'Navigation works',
        style: Theme.of(context).textTheme.headlineMedium,
      ),
      const SizedBox(height: 12),
      Text(
        'You opened the “${feature.replaceAll('-', ' ')}” destination. This preview uses a placeholder; the production feature and private data are not loaded.',
      ),
      const SizedBox(height: 20),
      FilledButton.icon(
        onPressed: () =>
            context.canPop() ? context.pop() : context.go('/library'),
        icon: const Icon(Icons.arrow_back_rounded),
        label: const Text('Back'),
      ),
    ],
  );
}
