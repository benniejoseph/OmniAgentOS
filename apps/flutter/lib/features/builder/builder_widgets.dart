import 'package:flutter/material.dart';

import 'builder_contracts.dart';
import 'builder_controller.dart';

// Every persisted widget state has its own exact owner/project namespace.
// An ExpansionTile stores a bool; sharing the scroll key would read a double.
PageStorageKey<Object> builderStorageKey(
  BuilderController controller,
  String identity,
) => PageStorageKey<Object>((
  controller.access.owner?.key,
  controller.projectId,
  identity,
));

/// The host supplies a platform capability. It must recheck isCurrent directly
/// at the OS open boundary. Builder never launches an external app by itself.
abstract interface class NativeBuilderExternalOpener {
  Future<bool> open(Uri uri, {required bool Function() isCurrent});
}

class BuilderNotice extends StatelessWidget {
  const BuilderNotice(this.text, {super.key, this.error = false});
  final String text;
  final bool error;
  @override
  Widget build(BuildContext context) => Semantics(
    liveRegion: true,
    child: Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(vertical: 6),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: error
            ? Theme.of(context).colorScheme.errorContainer
            : Theme.of(context).colorScheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        text,
        style: TextStyle(
          color: error
              ? Theme.of(context).colorScheme.onErrorContainer
              : Theme.of(context).colorScheme.onSurface,
        ),
      ),
    ),
  );
}

class BuilderIdentity extends StatelessWidget {
  const BuilderIdentity(this.label, this.value, {super.key});
  final String label, value;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 5),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: Theme.of(context).textTheme.labelMedium),
        SelectableText(value, style: Theme.of(context).textTheme.bodySmall),
      ],
    ),
  );
}

class BuilderActionButton extends StatelessWidget {
  const BuilderActionButton(
    this.label,
    this.action, {
    super.key,
    this.primary = false,
  });
  final String label;
  final VoidCallback? action;
  final bool primary;
  @override
  Widget build(BuildContext context) {
    final style = ButtonStyle(
      minimumSize: const WidgetStatePropertyAll(Size(48, 48)),
      padding: const WidgetStatePropertyAll(
        EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      ),
      tapTargetSize: MaterialTapTargetSize.padded,
    );
    return primary
        ? FilledButton(onPressed: action, style: style, child: Text(label))
        : OutlinedButton(onPressed: action, style: style, child: Text(label));
  }
}

class BuilderRecordSelector extends StatelessWidget {
  const BuilderRecordSelector({
    super.key,
    required this.label,
    required this.records,
    required this.value,
    required this.select,
    this.enabled = true,
  });
  final String label;
  final List<BuilderRecord> records;
  final String? value;
  final ValueChanged<String>? select;
  final bool enabled;
  @override
  Widget build(BuildContext context) {
    final missing = value != null && !records.any((row) => row.id == value);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        DropdownButtonFormField<String>(
          key: ValueKey('$label:$value'),
          initialValue: value,
          isExpanded: true,
          decoration: InputDecoration(labelText: label),
          items: [
            if (missing)
              DropdownMenuItem(
                value: value,
                child: const Text(
                  'Selected record unavailable',
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ...records.map(
              (record) => DropdownMenuItem(
                value: record.id,
                child: Text(
                  '${record.status.isEmpty ? record.kind : record.status} · ${record.id}',
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ),
          ],
          onChanged: enabled
              ? (id) {
                  if (id != null) {
                    select?.call(id);
                  }
                }
              : null,
        ),
        if (value != null) BuilderIdentity('Exact selected identity', value!),
        if (missing)
          const BuilderNotice(
            'The exact selected record is outside this bounded snapshot or is no longer available. Choose another record explicitly.',
          ),
      ],
    );
  }
}

class BuilderOutcomePanel extends StatelessWidget {
  const BuilderOutcomePanel({super.key, required this.controller});
  final BuilderController controller;
  @override
  Widget build(BuildContext context) {
    final outcome = controller.outcome;
    if (outcome == null) {
      return const SizedBox.shrink();
    }
    final label = switch (outcome.state) {
      BuilderOutcomeState.prepared => 'Submitted action pending',
      BuilderOutcomeState.accepted => 'Action response received',
      BuilderOutcomeState.rejected =>
        'Action rejected before dispatch or admission',
      BuilderOutcomeState.uncertain => 'Action outcome uncertain',
    };
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '$label · ${outcome.action}',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            Text(
              outcome.state == BuilderOutcomeState.accepted
                  ? controller.readError != null
                        ? 'The action returned successfully. Its receipt is retained independently of the failed workspace refresh.'
                        : 'This server response identifies the accepted action. Inspect its current records and evidence.'
                  : controller.uncertain
                  ? 'No action will be retried automatically. A prepared record recovered after restart is also uncertain. Refresh the server state and inspect Activity and these exact targets before making a new decision.'
                  : outcome.detail ?? 'No further action was submitted.',
            ),
            ExpansionTile(
              key: builderStorageKey(controller, 'outcome:${outcome.key}'),
              title: const Text('Exact submitted targets'),
              tilePadding: EdgeInsets.zero,
              childrenPadding: EdgeInsets.zero,
              children: [
                BuilderIdentity('Request key', outcome.key),
                ...outcome.submitted.entries
                    .where(
                      (entry) => !const {
                        'content',
                        'body',
                        'title',
                      }.contains(entry.key),
                    )
                    .map(
                      (entry) => BuilderIdentity(entry.key, '${entry.value}'),
                    ),
                if (outcome.receipt != null)
                  BuilderIdentity('Service receipt digest', outcome.receipt!),
              ],
            ),
            if (controller.uncertain)
              BuilderActionButton(
                'I inspected refreshed evidence; allow a new decision',
                controller.fresh &&
                        controller.outcomeReviewed &&
                        !controller.acting
                    ? () => controller.allowNewDecision()
                    : null,
              ),
          ],
        ),
      ),
    );
  }
}

class BuilderEvidencePanel extends StatelessWidget {
  const BuilderEvidencePanel({super.key, required this.controller});
  final BuilderController controller;
  @override
  Widget build(BuildContext context) {
    final snapshot = controller.snapshot,
        verification = controller.selectedVerification,
        deployment = controller.selectedDeployment,
        release = controller.selectedRelease;
    return ExpansionTile(
      key: builderStorageKey(controller, 'verification-release-evidence'),
      title: const Text('Exact verification and release evidence'),
      tilePadding: EdgeInsets.zero,
      children: [
        if (verification != null) ...[
          BuilderIdentity('Verification', verification.id),
          BuilderIdentity('Checkpoint', verification.text('checkpointId')),
          BuilderIdentity(
            'Workspace SHA-256',
            verification.text('workspaceSha256'),
          ),
          BuilderNotice(
            verification.text('checkpointId') == snapshot?.session?.checkpointId
                ? 'This check targets the current checkpoint. ${snapshot!.passingSentinel(verification) ? 'A matching passing Sentinel receipt is recorded.' : 'A separate passing Sentinel receipt is not recorded.'}'
                : 'Historical verification. It does not authorize delivery of the current checkpoint.',
          ),
          ...builderList(verification.raw['checks'], 2, (value) => value).map(
            (check) => ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text('${check['command']} · ${check['status']}'),
              subtitle: SelectableText(
                'Exit ${check['exitCode']} · ${check['durationMs']} ms\nOutput ${check['outputSha256']}',
              ),
            ),
          ),
        ],
        const BuilderNotice(
          'Lint and typecheck are deterministic checks. Legacy browser captures are retired from readiness and do not prove visual inspection. Native verification does not start a Sentinel Agent or manufacture a PASS verdict.',
        ),
        if (deployment != null) ...[
          BuilderIdentity('Selected preview deployment', deployment.id),
          BuilderIdentity(
            'Preview source checkpoint',
            deployment.text('checkpointId'),
          ),
          BuilderIdentity(
            'Preview verification',
            deployment.text('verificationId'),
          ),
          BuilderIdentity(
            'Manifest SHA-256',
            deployment.text('fileManifestSha256'),
          ),
          BuilderNotice(
            'Preview ${deployment.status} · build logs ${deployment.object('logs')['status']} · route checks ${deployment.object('routeEvidence')['status']}',
          ),
          ...builderList(
            deployment.object('routeEvidence')['routes'],
            100,
            (value) => value,
          ).map(
            (route) => ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text('${route['path']} · ${route['status']}'),
              subtitle: Text(
                'Response ${route['statusCode'] ?? route['errorCode'] ?? 'unavailable'} · ${route['durationMs']} ms',
              ),
            ),
          ),
        ],
        if (release != null) ...[
          BuilderIdentity('Production release', release.id),
          BuilderIdentity('Reviewed preview', release.text('deploymentId')),
          BuilderIdentity('Release digest', release.text('releaseDigest')),
          BuilderIdentity('Review expires', release.text('expiresAt')),
          BuilderIdentity(
            'Recorded rollback provider target',
            '${release.object('rollbackEvidence')['providerDeploymentId'] ?? 'First release; no previous production target'}',
          ),
          BuilderNotice(
            'Production ${release.status}. Rollback evidence records a previous target. The published API has no rollback action; no rollback has been requested.',
          ),
        ],
      ],
    );
  }
}
