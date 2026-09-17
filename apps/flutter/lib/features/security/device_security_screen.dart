import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../app/platform/macos_presentation.dart';
import '../../app/theme/macos_app_theme.dart';
import '../push/mobile_push.dart';
import 'device_security.dart';
import 'device_security_providers.dart';

class DeviceSecurityScreen extends ConsumerWidget {
  const DeviceSecurityScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final controller = ref.watch(deviceSecurityControllerProvider);
    final push = ref.watch(mobilePushCoordinatorProvider);
    if (usesMacosPresentation()) {
      return _MacDeviceSecurityWorkspace(
        controller: controller,
        push: push,
        onChange: (device, action) =>
            _confirmDeviceChange(context, controller, device, action),
      );
    }
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

class _MacDeviceSecurityWorkspace extends StatefulWidget {
  const _MacDeviceSecurityWorkspace({
    required this.controller,
    required this.push,
    required this.onChange,
  });

  final DeviceSecurityController controller;
  final MobilePushCoordinator? push;
  final Future<void> Function(
    MobileDeviceSession device,
    DeviceLifecycleAction action,
  )
  onChange;

  @override
  State<_MacDeviceSecurityWorkspace> createState() =>
      _MacDeviceSecurityWorkspaceState();
}

class _MacDeviceSecurityWorkspaceState
    extends State<_MacDeviceSecurityWorkspace> {
  String? _selectedId;

  MobileDeviceSession? get _selected {
    final devices = widget.controller.devices;
    if (devices.isEmpty) return null;
    for (final device in devices) {
      if (device.id == _selectedId) return device;
    }
    for (final device in devices) {
      if (device.current) return device;
    }
    return devices.first;
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    final selected = _selected;
    final active = controller.devices
        .where((device) => device.state == 'active')
        .length;
    final wipePending = controller.devices
        .where((device) => device.state == 'wipe_pending')
        .length;
    return MacosPageScaffold(
      title: 'Devices & Security',
      description: 'Control access to this private workspace and every signed-in installation.',
      icon: Icons.admin_panel_settings_outlined,
      actions: [
        IconButton(
          tooltip: 'Refresh devices',
          onPressed: controller.loading ? null : controller.refresh,
          icon: controller.loading
              ? const SizedBox.square(
                  dimension: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.refresh_rounded),
        ),
      ],
      toolbar: _MacSecuritySummary(
        active: active,
        total: controller.devices.length,
        wipePending: wipePending,
        localUnlock: controller.biometricEnabled,
      ),
      body: _MacDeviceLedger(
        controller: controller,
        push: widget.push,
        selectedId: selected?.id,
        onSelected: (device) => setState(() => _selectedId = device.id),
      ),
      inspector: _MacDeviceInspector(
        device: selected,
        busy:
            selected != null &&
            controller.changingDevices.contains(selected.id),
        onChange: selected == null
            ? null
            : (action) => widget.onChange(selected, action),
      ),
      inspectorWidth: 340,
    );
  }
}

class _MacSecuritySummary extends StatelessWidget {
  const _MacSecuritySummary({
    required this.active,
    required this.total,
    required this.wipePending,
    required this.localUnlock,
  });

  final int active;
  final int total;
  final int wipePending;
  final bool localUnlock;

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
    scrollDirection: Axis.horizontal,
    child: Row(
      children: [
        _MacSecurityMetric(
          icon: Icons.devices_other_rounded,
          label: '$active of $total active',
        ),
        const _MacToolbarDivider(),
        _MacSecurityMetric(
          icon: Icons.fingerprint_rounded,
          label: localUnlock ? 'Local unlock protected' : 'Password unlock',
        ),
        if (wipePending > 0) ...[
          const _MacToolbarDivider(),
          _MacSecurityMetric(
            icon: Icons.phonelink_erase_rounded,
            label: '$wipePending wipe pending',
            warning: true,
          ),
        ],
      ],
    ),
  );
}

class _MacToolbarDivider extends StatelessWidget {
  const _MacToolbarDivider();

  @override
  Widget build(BuildContext context) => Container(
    width: 1,
    height: 18,
    margin: const EdgeInsets.symmetric(horizontal: 14),
    color: MacosThemeColors.of(context).divider,
  );
}

class _MacSecurityMetric extends StatelessWidget {
  const _MacSecurityMetric({
    required this.icon,
    required this.label,
    this.warning = false,
  });

  final IconData icon;
  final String label;
  final bool warning;

  @override
  Widget build(BuildContext context) {
    final color = warning
        ? MacosThemeColors.of(context).warning
        : Theme.of(context).colorScheme.onSurfaceVariant;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 15, color: color),
        const SizedBox(width: 6),
        Text(label, style: Theme.of(context).textTheme.labelMedium),
      ],
    );
  }
}

class _MacDeviceLedger extends StatelessWidget {
  const _MacDeviceLedger({
    required this.controller,
    required this.push,
    required this.selectedId,
    required this.onSelected,
  });

  final DeviceSecurityController controller;
  final MobilePushCoordinator? push;
  final String? selectedId;
  final ValueChanged<MobileDeviceSession> onSelected;

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.fromLTRB(18, 18, 18, 36),
    children: [
      const MacosSectionHeader(
        title: 'Protection on this Mac',
        description:
            'Unlock and notification preferences apply to this installation.',
      ),
      const SizedBox(height: 10),
      LayoutBuilder(
        builder: (context, constraints) {
          final controls = <Widget>[
            _MacBiometricControl(controller: controller),
            if (push != null) _MacPushControl(coordinator: push!),
          ];
          if (controls.length == 1 || constraints.maxWidth < 720) {
            return Column(
              children: [
                for (var index = 0; index < controls.length; index++) ...[
                  if (index > 0) const SizedBox(height: 8),
                  controls[index],
                ],
              ],
            );
          }
          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: controls[0]),
              const SizedBox(width: 10),
              Expanded(child: controls[1]),
            ],
          );
        },
      ),
      const SizedBox(height: 24),
      MacosSectionHeader(
        title: 'Signed-in installations',
        description: 'Select a device to inspect access, revoke its session, or request local erasure.',
        trailing: Text(
          '${controller.devices.length} total',
          style: Theme.of(context).textTheme.labelMedium,
        ),
      ),
      if (controller.error != null) ...[
        const SizedBox(height: 10),
        _MacSecurityError(error: controller.error!),
      ],
      const SizedBox(height: 10),
      if (controller.loading && controller.devices.isEmpty)
        const Padding(
          padding: EdgeInsets.all(32),
          child: Center(child: CircularProgressIndicator()),
        )
      else if (controller.devices.isEmpty)
        const MacosEmptyState(
          icon: Icons.devices_other_rounded,
          title: 'No signed-in installations',
          message: 'Native installations will appear after they sign in.',
        )
      else
        _MacDeviceTable(
          devices: controller.devices,
          selectedId: selectedId,
          busyIds: controller.changingDevices,
          onSelected: onSelected,
        ),
    ],
  );
}

class _MacBiometricControl extends StatelessWidget {
  const _MacBiometricControl({required this.controller});

  final DeviceSecurityController controller;

  @override
  Widget build(BuildContext context) => MacosPane(
    padding: const EdgeInsets.fromLTRB(14, 12, 10, 12),
    child: Row(
      children: [
        const Icon(Icons.fingerprint_rounded, size: 20),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Touch ID unlock',
                style: Theme.of(context).textTheme.titleSmall,
              ),
              const SizedBox(height: 2),
              Text(
                controller.biometricAvailable
                    ? 'Require local authentication before releasing credentials.'
                    : 'Touch ID is not enrolled on this Mac.',
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
        ),
        Switch.adaptive(
          value: controller.biometricEnabled,
          onChanged:
              (!controller.biometricAvailable &&
                      !controller.biometricEnabled) ||
                  controller.changingBiometric
              ? null
              : (enabled) => _setBiometric(context, controller, enabled),
        ),
      ],
    ),
  );

  Future<void> _setBiometric(
    BuildContext context,
    DeviceSecurityController controller,
    bool enabled,
  ) async {
    try {
      await controller.setBiometricEnabled(enabled);
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            enabled ? 'Touch ID unlock enabled.' : 'Touch ID unlock disabled.',
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

class _MacPushControl extends StatelessWidget {
  const _MacPushControl({required this.coordinator});

  final MobilePushCoordinator coordinator;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: coordinator,
    builder: (context, _) {
      final busy = coordinator.state == MobilePushState.initializing;
      final ready = coordinator.state == MobilePushState.ready;
      return MacosPane(
        padding: const EdgeInsets.fromLTRB(14, 12, 10, 12),
        child: Row(
          children: [
            const Icon(Icons.notifications_active_outlined, size: 20),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          'Desktop notifications',
                          style: Theme.of(context).textTheme.titleSmall,
                        ),
                      ),
                      const SizedBox(width: 8),
                      _MacStateBadge(
                        label: _pushStateLabel(coordinator.state),
                        tone: ready
                            ? _MacBadgeTone.positive
                            : _MacBadgeTone.neutral,
                      ),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    ready
                        ? 'Approval and work updates open their exact source.'
                        : 'Receive actionable approval and work updates.',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
            if (!ready)
              TextButton(
                onPressed: busy ? null : coordinator.enable,
                child: Text(busy ? 'Connecting…' : 'Enable'),
              ),
          ],
        ),
      );
    },
  );
}

class _MacDeviceTable extends StatelessWidget {
  const _MacDeviceTable({
    required this.devices,
    required this.selectedId,
    required this.busyIds,
    required this.onSelected,
  });

  final List<MobileDeviceSession> devices;
  final String? selectedId;
  final Set<String> busyIds;
  final ValueChanged<MobileDeviceSession> onSelected;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final compact = constraints.maxWidth < 760;
      return MacosPane(
        padding: EdgeInsets.zero,
        child: Column(
          children: [
            _MacDeviceTableHeader(compact: compact),
            for (var index = 0; index < devices.length; index++) ...[
              if (index > 0)
                Divider(height: 1, color: MacosThemeColors.of(context).divider),
              _MacDeviceRow(
                key: ValueKey('macos-device-${devices[index].id}'),
                device: devices[index],
                selected: devices[index].id == selectedId,
                busy: busyIds.contains(devices[index].id),
                compact: compact,
                onTap: () => onSelected(devices[index]),
              ),
            ],
          ],
        ),
      );
    },
  );
}

class _MacDeviceTableHeader extends StatelessWidget {
  const _MacDeviceTableHeader({required this.compact});

  final bool compact;

  @override
  Widget build(BuildContext context) {
    final style = Theme.of(context).textTheme.labelSmall;
    return Container(
      height: 34,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      color: MacosThemeColors.of(context).toolbar,
      child: Row(
        children: [
          Expanded(child: Text('INSTALLATION', style: style)),
          SizedBox(width: 112, child: Text('STATUS', style: style)),
          if (!compact)
            SizedBox(width: 138, child: Text('CLIENT', style: style)),
          SizedBox(width: 148, child: Text('LAST ACTIVE', style: style)),
        ],
      ),
    );
  }
}

class _MacDeviceRow extends StatelessWidget {
  const _MacDeviceRow({
    super.key,
    required this.device,
    required this.selected,
    required this.busy,
    required this.compact,
    required this.onTap,
  });

  final MobileDeviceSession device;
  final bool selected;
  final bool busy;
  final bool compact;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Material(
    color: selected
        ? MacosThemeColors.of(context).selection
        : Colors.transparent,
    child: InkWell(
      onTap: onTap,
      child: SizedBox(
        height: 54,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Row(
            children: [
              Expanded(
                child: Row(
                  children: [
                    Icon(_devicePlatformIcon(device.platform), size: 18),
                    const SizedBox(width: 9),
                    Flexible(
                      child: Text(
                        device.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                    ),
                    if (device.current) ...[
                      const SizedBox(width: 7),
                      const _MacStateBadge(
                        label: 'This Mac',
                        tone: _MacBadgeTone.accent,
                      ),
                    ],
                  ],
                ),
              ),
              SizedBox(
                width: 112,
                child: _MacStateBadge(
                  label: _humanize(device.state),
                  tone: _deviceBadgeTone(device.state),
                ),
              ),
              if (!compact)
                SizedBox(
                  width: 138,
                  child: Text(
                    device.versionLabel,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              SizedBox(
                width: 148,
                child: busy
                    ? const Align(
                        alignment: Alignment.centerLeft,
                        child: SizedBox.square(
                          dimension: 15,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      )
                    : Text(
                        _formatDate(device.lastSeenAt),
                        maxLines: 1,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

class _MacDeviceInspector extends StatelessWidget {
  const _MacDeviceInspector({
    required this.device,
    required this.busy,
    required this.onChange,
  });

  final MobileDeviceSession? device;
  final bool busy;
  final ValueChanged<DeviceLifecycleAction>? onChange;

  @override
  Widget build(BuildContext context) {
    final selected = device;
    if (selected == null) {
      return const MacosEmptyState(
        icon: Icons.devices_other_rounded,
        title: 'No device selected',
        message: 'Choose an installation to inspect its access.',
      );
    }
    return ListView(
      key: ValueKey('macos-device-inspector-${selected.id}'),
      padding: const EdgeInsets.all(18),
      children: [
        Icon(_devicePlatformIcon(selected.platform), size: 30),
        const SizedBox(height: 12),
        Text(selected.name, style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 7),
        Wrap(
          spacing: 7,
          runSpacing: 7,
          children: [
            _MacStateBadge(
              label: _humanize(selected.state),
              tone: _deviceBadgeTone(selected.state),
            ),
            if (selected.current)
              const _MacStateBadge(
                label: 'Current installation',
                tone: _MacBadgeTone.accent,
              ),
          ],
        ),
        const SizedBox(height: 20),
        const _MacInspectorLabel('ACCESS DETAILS'),
        _MacInspectorValue(
          label: 'Platform',
          value: _humanize(selected.platform),
        ),
        _MacInspectorValue(label: 'Client', value: selected.versionLabel),
        _MacInspectorValue(
          label: 'First signed in',
          value: _formatDate(selected.createdAt),
        ),
        _MacInspectorValue(
          label: 'Last active',
          value: _formatDate(selected.lastSeenAt),
        ),
        if (selected.revocationReason != null)
          _MacInspectorValue(
            label: 'Reason',
            value: _humanize(selected.revocationReason!),
          ),
        const SizedBox(height: 18),
        Divider(color: MacosThemeColors.of(context).divider),
        const SizedBox(height: 14),
        if (selected.current)
          Text(
            'This installation cannot revoke or erase itself from this panel.',
            style: Theme.of(context).textTheme.bodySmall,
          )
        else if (busy)
          const Center(child: CircularProgressIndicator())
        else ...[
          if (selected.canRevoke)
            OutlinedButton.icon(
              onPressed: () => onChange?.call(DeviceLifecycleAction.revoke),
              icon: const Icon(Icons.logout_rounded),
              label: const Text('Revoke session'),
            ),
          if (selected.canRevoke && selected.canRemoteWipe)
            const SizedBox(height: 8),
          if (selected.canRemoteWipe)
            FilledButton.tonalIcon(
              onPressed: () => onChange?.call(DeviceLifecycleAction.remoteWipe),
              icon: const Icon(Icons.phonelink_erase_rounded),
              label: const Text('Request remote wipe'),
            ),
        ],
        const SizedBox(height: 12),
        Text(
          selected.wipeAcknowledged
              ? 'Local erasure was acknowledged by this installation.'
              : 'Remote wipe takes effect when the installation next connects.',
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ],
    );
  }
}

class _MacInspectorLabel extends StatelessWidget {
  const _MacInspectorLabel(this.label);

  final String label;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Text(label, style: Theme.of(context).textTheme.labelSmall),
  );
}

class _MacInspectorValue extends StatelessWidget {
  const _MacInspectorValue({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 5),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 104,
          child: Text(label, style: Theme.of(context).textTheme.bodySmall),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: SelectableText(
            value,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
        ),
      ],
    ),
  );
}

class _MacSecurityError extends StatelessWidget {
  const _MacSecurityError({required this.error});

  final Object error;

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.errorContainer,
      border: Border.all(
        color: Theme.of(context).colorScheme.error.withValues(alpha: .28),
      ),
      borderRadius: BorderRadius.circular(8),
    ),
    child: Row(
      children: [
        Icon(
          Icons.error_outline_rounded,
          size: 17,
          color: Theme.of(context).colorScheme.error,
        ),
        const SizedBox(width: 8),
        Expanded(child: Text(error.toString())),
      ],
    ),
  );
}

enum _MacBadgeTone { neutral, accent, positive, warning }

class _MacStateBadge extends StatelessWidget {
  const _MacStateBadge({required this.label, required this.tone});

  final String label;
  final _MacBadgeTone tone;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final mac = MacosThemeColors.of(context);
    final (foreground, background) = switch (tone) {
      _MacBadgeTone.neutral => (scheme.onSurfaceVariant, mac.hover),
      _MacBadgeTone.accent => (scheme.primary, mac.selection),
      _MacBadgeTone.positive => (
        mac.positive,
        mac.positive.withValues(alpha: .1),
      ),
      _MacBadgeTone.warning => (mac.warning, mac.warning.withValues(alpha: .1)),
    };
    return DecoratedBox(
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(5),
        border: Border.all(color: foreground.withValues(alpha: .2)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
        child: Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: Theme.of(context).textTheme.labelSmall
              ?.copyWith(color: foreground, fontWeight: FontWeight.w700),
        ),
      ),
    );
  }
}

IconData _devicePlatformIcon(String platform) =>
    switch (platform.toLowerCase()) {
      'macos' || 'mac' || 'darwin' => Icons.laptop_mac_rounded,
      'ios' => Icons.phone_iphone_rounded,
      'android' => Icons.phone_android_rounded,
      'windows' => Icons.laptop_windows_rounded,
      'linux' => Icons.computer_rounded,
      _ => Icons.devices_other_rounded,
    };

_MacBadgeTone _deviceBadgeTone(String state) => switch (state) {
  'active' => _MacBadgeTone.positive,
  'wipe_pending' => _MacBadgeTone.warning,
  _ => _MacBadgeTone.neutral,
};

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
