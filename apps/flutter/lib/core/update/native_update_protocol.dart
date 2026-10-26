import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/widgets.dart';

/// Read-only activity; no content, command or credential crosses this boundary.
abstract interface class NativeUpdateActivity {
  Set<String> get nativeUpdateBusyReasons;
}

const nativeUpdateBusyReasons = {
  'build_mismatch',
  'owner_mismatch',
  'session_unavailable',
  'workspace_locked',
  'workspace_not_ready',
  'route_not_rendered',
  'unsaved_draft',
  'inspection_incomplete',
  'desktop_enabled',
  'desktop_busy',
  'capture_busy',
  'auxiliary_window',
  'voice_active',
  'conversation_busy',
  'host_unavailable',
  'request_in_progress',
};
const nativeUpdateTransientSearchKey = ValueKey('improvement-history-search');

bool nativeUpdateImprovementRoute(String value) {
  final uri = Uri.tryParse(value);
  return uri != null &&
      !uri.hasScheme &&
      !uri.hasAuthority &&
      !uri.hasFragment &&
      uri.path == '/improvement' &&
      uri.queryParametersAll.entries.every(
        (entry) =>
            entry.key == 'cycle' &&
            entry.value.length == 1 &&
            RegExp(r'^self_cycle_[a-f0-9]{64}$').hasMatch(entry.value.single),
      );
}

class NativeUpdateRequest {
  const NativeUpdateRequest(
    this.action,
    this.nonce,
    this.expected,
    this.nativeBusy,
  );
  final String action, nonce;
  final Map<String, Object?> expected;
  final Set<String> nativeBusy;

  static NativeUpdateRequest parse(Object? value) {
    if (value is! Map ||
        value.keys.toSet().difference({
          'protocol',
          'action',
          'nonce',
          'expected',
          'nativeBusyReasons',
        }).isNotEmpty ||
        value['protocol'] != 1 ||
        !{'status', 'quiesce', 'commit'}.contains(value['action']) ||
        value['nonce'] is! String ||
        !RegExp(r'^[a-f0-9]{64}$').hasMatch(value['nonce'] as String)) {
      throw const FormatException('Invalid native update request.');
    }
    final expected = value['expected'];
    if (expected is! Map ||
        expected.length != 5 ||
        !RegExp(r'^[a-f0-9]{40}$').hasMatch('${expected['sourceRevision']}') ||
        !RegExp(r'^[a-f0-9]{64}$')
            .hasMatch('${expected['sourceSnapshotSha256']}') ||
        !RegExp(r'^[0-9]+\.[0-9]+\.[0-9]+$')
            .hasMatch('${expected['version']}') ||
        expected['build'] is! int ||
        (expected['build'] as int) <= 0 ||
        (expected['build'] as int) > 2147483647 ||
        !RegExp(r'^[a-f0-9]{64}$').hasMatch('${expected['ownerSha256']}')) {
      throw const FormatException('Invalid native update binding.');
    }
    final busy = value['nativeBusyReasons'] ?? const [];
    if (busy is! List ||
        busy.length > 20 ||
        busy.any((reason) => !nativeUpdateBusyReasons.contains(reason))) {
      throw const FormatException('Invalid native update activity.');
    }
    return NativeUpdateRequest(
      value['action'] as String,
      value['nonce'] as String,
      Map<String, Object?>.from(expected),
      busy.cast<String>().toSet(),
    );
  }
}

Future<String> nativeUpdateOwnerDigest(String tenantId, String userId) async {
  final digest = await Sha256().hash(
    utf8.encode(jsonEncode([tenantId, 'actor:${userId.toLowerCase()}'])),
  );
  return digest.bytes
      .map((value) => value.toRadixString(16).padLeft(2, '0'))
      .join();
}

/// Inspect every mounted branch, including offstage drafts. The only exempt
/// input is the known transient history search. Text never leaves this process.
Set<String> inspectNativeUpdateActivity(Element root, {int limit = 30000}) {
  final reasons = <String>{};
  var count = 0;
  void visit(Element element) {
    if (++count > limit) {
      reasons.add('inspection_incomplete');
      return;
    }
    if (element is StatefulElement && element.state is NativeUpdateActivity) {
      final declared =
          (element.state as NativeUpdateActivity).nativeUpdateBusyReasons;
      reasons.addAll(declared.where(nativeUpdateBusyReasons.contains));
      if (declared.any((value) => !nativeUpdateBusyReasons.contains(value))) {
        reasons.add('inspection_incomplete');
      }
    }
    final widget = element.widget;
    if (widget is EditableText &&
        !widget.readOnly &&
        widget.controller.text.isNotEmpty) {
      var transient = false;
      element.visitAncestorElements((parent) {
        if (parent.widget.key == nativeUpdateTransientSearchKey) {
          transient = true;
        }
        return !transient;
      });
      if (!transient) reasons.add('unsaved_draft');
    }
    element.visitChildElements(visit);
  }

  visit(root);
  return reasons;
}
