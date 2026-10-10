import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/platform/android_device_bridge.dart';
import '../computer_use/android_phone.dart';

class AndroidPhoneSettings extends ConsumerStatefulWidget {
  const AndroidPhoneSettings({super.key});
  @override
  ConsumerState<AndroidPhoneSettings> createState() =>
      _AndroidPhoneSettingsState();
}

class _AndroidPhoneSettingsState extends ConsumerState<AndroidPhoneSettings>
    with WidgetsBindingObserver {
  bool _agreed = false;
  String? _notice;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed)
      unawaited(ref.read(androidPhoneProvider).refresh());
  }

  @override
  Widget build(BuildContext context) {
    final phone = ref.watch(androidPhoneProvider);
    final status = phone.status;
    final enabled = phone.ready;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.phone_android_rounded),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'This phone',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                if (enabled)
                  FilledButton.tonalIcon(
                    onPressed: () => phone.stop(),
                    icon: const Icon(Icons.stop_rounded),
                    label: const Text('Stop'),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              enabled
                  ? 'Ready · choose This phone in Assistant to let ATLAS use your apps.'
                  : status?.supported == false
                  ? 'Phone control needs Android 14 or later. You can still use Asael and voice normally.'
                  : 'Let ATLAS open apps, understand what is on screen, and carry out your instructions.',
            ),
            const SizedBox(height: 12),
            const Text(
              'When you select This phone, Asael uses Android Accessibility to read visible screen text and images and to tap, type, scroll, or navigate. Screen content needed for your request is sent to Asael and your selected AI provider. Other apps’ content is treated as information, never as permission.',
            ),
            const SizedBox(height: 8),
            const Text(
              'Access is active for up to 30 minutes with a visible notification. Stop ends control immediately. Locking your phone or signing out also stops it. Password fields, protected screens and Asael’s approval controls are unavailable. Voice separately asks for microphone access and sends live audio to OpenAI.',
            ),
            if (!enabled) ...[
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                value: _agreed,
                onChanged: phone.busy
                    ? null
                    : (value) => setState(() => _agreed = value == true),
                title: const Text(
                  'I understand and allow this screen access for my requests.',
                ),
                controlAffinity: ListTileControlAffinity.leading,
              ),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  OutlinedButton.icon(
                    onPressed:
                        !_agreed || phone.busy || status?.supported == false
                        ? null
                        : () async {
                            try {
                              await appAndroidDeviceBridge
                                  .openAccessibilitySettings();
                            } catch (_) {
                              if (mounted)
                                setState(
                                  () => _notice = 'Open Android Settings → Accessibility → Installed apps → Asael.',
                                );
                            }
                          },
                    icon: const Icon(Icons.accessibility_new_rounded),
                    label: const Text('Allow Accessibility'),
                  ),
                  FilledButton.icon(
                    onPressed:
                        !_agreed ||
                            phone.busy ||
                            status?.accessibility != 'granted'
                        ? null
                        : () async {
                            try {
                              final permission = await appAndroidDeviceBridge
                                  .requestNotifications();
                              if (!mounted) return;
                              if (!permission.notificationsGranted) {
                                setState(
                                  () => _notice = 'Allow notifications so Stop remains available in other apps.',
                                );
                                return;
                              }
                              await phone.enable();
                            } catch (_) {
                              if (mounted)
                                setState(
                                  () => _notice = 'Phone access could not start. Check permissions and try again.',
                                );
                            }
                          },
                    icon: const Icon(Icons.play_arrow_rounded),
                    label: Text(phone.busy ? 'Starting…' : 'Enable This phone'),
                  ),
                  TextButton(
                    onPressed: () => phone.refresh(),
                    child: const Text('Refresh'),
                  ),
                ],
              ),
            ],
            if (_notice != null || phone.notice != null)
              Padding(
                padding: const EdgeInsets.only(top: 10),
                child: Text(_notice ?? phone.notice!),
              ),
          ],
        ),
      ),
    );
  }
}
