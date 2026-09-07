import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../push/mobile_push.dart';
import 'device_security.dart';
import 'device_security_providers.dart';

class DeviceSecurityScreen extends ConsumerWidget {
  const DeviceSecurityScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final controller = ref.watch(deviceSecurityControllerProvider);
    final push = ref.watch(mobilePushCoordinatorProvider);
    return Scaffold(
      appBar: AppBar(
        title: const Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Devices & security'),
            Text(
              'Your installations and local unlock',
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w400),
            ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: 'Refresh devices',
            onPressed: controller.loading ? null : controller.refresh,
            icon: const Icon(Icons.refresh_rounded),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: controller.refresh,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 48),
          children: [
            Align(
              alignment: Alignment.topCenter,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 820),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _BiometricCard(controller: controller),
                    if (push != null) ...[
                      const SizedBox(height: 12),
                      _PushNotificationCard(coordinator: push),
                    ],
                    const SizedBox(height: 24),
                    Text(
                      'Signed-in devices',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 6),
                    Text(
                      'Revoke an unused session, or request local erasure for a lost device.',
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                    if (controller.error != null) ...[
                      const SizedBox(height: 14),
                      _ErrorCard(error: controller.error!),
                    ],
                    const SizedBox(height: 14),
                    if (controller.loading && controller.devices.isEmpty)
                      const Center(
                        child: Padding(
                          padding: EdgeInsets.all(32),
                          child: CircularProgressIndicator(),
                        ),
                      )
                    else if (controller.devices.isEmpty)
                      const Card(
                        child: Padding(
                          padding: EdgeInsets.all(24),
                          child: Text('No native device sessions were found.'),
                        ),
                      )
                    else
                      for (final device in controller.devices)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 10),
                          child: _DeviceCard(
                            device: device,
                            busy: controller.changingDevices.contains(
                              device.id,
                            ),
                            onChange: (action) => _confirmDeviceChange(
                              context,
                              controller,
                              device,
                              action,
                            ),
                          ),
                        ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _confirmDeviceChange(
    BuildContext context,
    DeviceSecurityController controller,
    MobileDeviceSession device,
    DeviceLifecycleAction action,
  ) async {
    final wiping = action == DeviceLifecycleAction.remoteWipe;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        icon: Icon(
          wiping ? Icons.phonelink_erase_rounded : Icons.logout_rounded,
        ),
        title: Text(wiping ? 'Wipe ${device.name}?' : 'Revoke ${device.name}?'),
        content: Text(
          wiping
              ? 'The session will be revoked now. When that installation next connects, Asael will erase its local credentials and acknowledge completion.'
              : 'This installation must sign in again before it can access the workspace.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: Text(wiping ? 'Request wipe' : 'Revoke'),
          ),
        ],
      ),
    );
    if (confirmed != true || !context.mounted) return;
    try {
      await controller.changeDevice(device, action);
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            wiping ? 'Remote wipe requested.' : 'Device session revoked.',
          ),
        ),
      );
    } catch (error) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error.toString())));
    }
  }
}

class _PushNotificationCard extends StatelessWidget {
  const _PushNotificationCard({required this.coordinator});

  final MobilePushCoordinator coordinator;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: coordinator,
    builder: (context, _) {
      final busy = coordinator.state == MobilePushState.initializing;
      final ready = coordinator.state == MobilePushState.ready;
      return Card(
        clipBehavior: Clip.antiAlias,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Icon(Icons.notifications_active_outlined),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      'Push notifications',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                  ),
                  Chip(
                    label: Text(_pushStateLabel(coordinator.state)),
                    visualDensity: VisualDensity.compact,
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                ready
                    ? 'Exact approvals and work updates can open their source screen on this device.'
                    : 'Enable notifications to receive causal links for approvals and work updates.',
              ),
              if (coordinator.error case final message?) ...[
                const SizedBox(height: 8),
                Text(
                  message,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ],
              const SizedBox(height: 14),
              DropdownButtonFormField<MobilePushPreviewPolicy>(
                initialValue: coordinator.previewPolicy,
                decoration: const InputDecoration(
                  labelText: 'Lock-screen preview',
                  border: OutlineInputBorder(),
                ),
                items: [
                  for (final policy in MobilePushPreviewPolicy.values)
                    DropdownMenuItem(value: policy, child: Text(policy.label)),
                ],
                onChanged: busy
                    ? null
                    : (policy) async {
                        if (policy == null) return;
                        try {
                          await coordinator.setPreviewPolicy(policy);
                        } catch (error) {
                          if (!context.mounted) return;
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(content: Text(error.toString())),
                          );
                        }
                      },
              ),
              if (!ready) ...[
                const SizedBox(height: 14),
                FilledButton.icon(
                  onPressed: busy ? null : coordinator.enable,
                  icon: busy
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.notifications_outlined),
                  label: Text(busy ? 'Connecting' : 'Enable notifications'),
                ),
              ],
            ],
          ),
        ),
      );
    },
  );
}

String _pushStateLabel(MobilePushState state) => switch (state) {
  MobilePushState.initializing => 'Connecting',
  MobilePushState.disabled => 'Off',
  MobilePushState.denied => 'Denied',
  MobilePushState.ready => 'Registered',
  MobilePushState.configurationRequired => 'Setup required',
  MobilePushState.error => 'Retry needed',
};

class _BiometricCard extends StatelessWidget {
  const _BiometricCard({required this.controller});

  final DeviceSecurityController controller;

  @override
  Widget build(BuildContext context) => Card(
    clipBehavior: Clip.antiAlias,
    child: SwitchListTile(
      secondary: const Icon(Icons.fingerprint_rounded),
      title: const Text('Biometric unlock'),
      subtitle: Text(
        controller.biometricAvailable
            ? 'Require an enrolled biometric before local credentials are released.'
            : 'No enrolled biometric is available on this device.',
      ),
      value: controller.biometricEnabled,
      onChanged:
          (!controller.biometricAvailable && !controller.biometricEnabled) ||
              controller.changingBiometric
          ? null
          : (enabled) async {
              try {
                await controller.setBiometricEnabled(enabled);
                if (!context.mounted) return;
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(
                    content: Text(
                      enabled
                          ? 'Biometric unlock enabled.'
                          : 'Biometric unlock disabled.',
                    ),
                  ),
                );
              } catch (error) {
                if (!context.mounted) return;
                ScaffoldMessenger.of(context)
                    .showSnackBar(SnackBar(content: Text(error.toString())));
              }
            },
    ),
  );
}

class _DeviceCard extends StatelessWidget {
  const _DeviceCard({
    required this.device,
    required this.busy,
    required this.onChange,
  });

  final MobileDeviceSession device;
  final bool busy;
  final ValueChanged<DeviceLifecycleAction> onChange;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.fromLTRB(16, 14, 10, 14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          CircleAvatar(
            child: Icon(
              device.platform == 'ios'
                  ? Icons.phone_iphone_rounded
                  : Icons.phone_android_rounded,
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Wrap(
                  spacing: 8,
                  runSpacing: 6,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text(
                      device.name,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    _StateChip(device: device),
                    if (device.current)
                      const Chip(
                        avatar: Icon(Icons.check_circle_rounded, size: 16),
                        label: Text('This device'),
                        visualDensity: VisualDensity.compact,
                      ),
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  '${device.versionLabel} · Last active ${_formatDate(device.lastSeenAt)}',
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
                if (device.revocationReason != null) ...[
                  const SizedBox(height: 3),
                  Text('Reason: ${_humanize(device.revocationReason!)}'),
                ],
              ],
            ),
          ),
          if (busy)
            const Padding(
              padding: EdgeInsets.all(12),
              child: SizedBox.square(
                dimension: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            )
          else if (device.canRevoke || device.canRemoteWipe)
            PopupMenuButton<DeviceLifecycleAction>(
              tooltip: 'Device actions',
              onSelected: onChange,
              itemBuilder: (_) => [
                if (device.canRevoke)
                  const PopupMenuItem(
                    value: DeviceLifecycleAction.revoke,
                    child: ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: Icon(Icons.logout_rounded),
                      title: Text('Revoke session'),
                    ),
                  ),
                if (device.canRemoteWipe)
                  const PopupMenuItem(
                    value: DeviceLifecycleAction.remoteWipe,
                    child: ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: Icon(Icons.phonelink_erase_rounded),
                      title: Text('Request remote wipe'),
                    ),
                  ),
              ],
            ),
        ],
      ),
    ),
  );
}

class _StateChip extends StatelessWidget {
  const _StateChip({required this.device});

  final MobileDeviceSession device;

  @override
  Widget build(BuildContext context) {
    final color = switch (device.state) {
      'active' => Colors.green,
      'wipe_pending' => Colors.orange,
      'wiped' => Colors.blueGrey,
      _ => Theme.of(context).colorScheme.outline,
    };
    return Chip(
      label: Text(_humanize(device.state)),
      side: BorderSide(color: color),
      visualDensity: VisualDensity.compact,
    );
  }
}

class _ErrorCard extends StatelessWidget {
  const _ErrorCard({required this.error});

  final Object error;

  @override
  Widget build(BuildContext context) => Card(
    color: Theme.of(context).colorScheme.errorContainer,
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Text(error.toString()),
    ),
  );
}

String _humanize(String value) => value
    .split('_')
    .where((part) => part.isNotEmpty)
    .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
    .join(' ');

String _formatDate(DateTime value) {
  final local = value.toLocal();
  String two(int number) => number.toString().padLeft(2, '0');
  return '${local.year}-${two(local.month)}-${two(local.day)} ${two(local.hour)}:${two(local.minute)}';
}
