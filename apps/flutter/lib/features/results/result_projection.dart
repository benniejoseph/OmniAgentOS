import 'dart:convert';

import 'result_contracts.dart';

/// Public transport fields only. Stored prose and structured evidence are
/// displayed as selectable text; they never become navigation or tool input.
class ParsedResult {
  ParsedResult({
    required this.key,
    required this.title,
    required this.status,
    required this.body,
    required this.meta,
    required this.evidence,
    required this.metadata,
    this.timestamp,
    this.canonical,
    this.grounding = 'unavailable',
    this.approvalKind,
    this.threadId,
  });
  final ResultKey key;
  final String title, status, body, meta, grounding;
  final List<String> evidence;
  final Map<String, String> metadata;
  final DateTime? timestamp;
  final ResultCanonical? canonical;
  final String? approvalKind, threadId;

  factory ParsedResult.agent(ResultJson value) {
    final key = ResultKey.parse(
      'agent:${resultText(value['id'], maximum: 200)}',
    );
    final status = resultMember(value['status'], [
      'queued',
      'running',
      'waiting_approval',
      'waiting_clarification',
      'resuming',
      'completed',
      'failed',
      'canceled',
    ]);
    final grounding = value['grounding'] == null
        ? null
        : resultRecord(value['grounding']);
    final groundingStatus = grounding == null
        ? 'unavailable'
        : resultMember(grounding['status'], [
            'verified',
            'missing',
            'invalid',
            'not_required',
            'unavailable',
          ]);
    final agentId = resultOptionalText(value['agentId']);
    return ParsedResult(
      key: key,
      title: resultText(value['prompt']),
      status: status,
      body: _body(value['response'] ?? value['error'], status, workflow: false),
      meta:
          '${agentId?.isNotEmpty == true ? agentId : 'Agent identity unavailable'} · ${resultOptionalText(value['mode']) ?? 'Mode unavailable'}',
      timestamp: _timestamp(value, [
        'completedAt',
        'updatedAt',
        'startedAt',
        'createdAt',
      ]),
      canonical: value['canonicalStatus'] == null
          ? null
          : ResultCanonical.fromJson(
              value['canonicalStatus'],
              domain: 'agent_run',
            ),
      grounding: groundingStatus,
      evidence: _evidence(grounding?['citations'] ?? grounding?['sources']),
      threadId: resultOptionalText(value['threadId']),
      metadata: _metadata(value, const {
        'agentId': 'Executing Agent ID',
        'specialistIds': 'Specialist IDs',
        'threadId': 'Conversation ID',
        'agentIdentity': 'Agent identity receipt',
        'identityPin': 'Pinned Agent identity',
        'terminalReceipt': 'Terminal receipt',
        'contextReceipt': 'Context provenance',
        'waitingApproval': 'Pending approval',
        'grounding': 'Grounding evidence',
        'fileArtifactState': 'Created file projection',
        'fileArtifacts': 'Exact created file versions',
        'workspaceArtifactState': 'Workspace file projection',
        'workspaceArtifacts': 'Workspace file evidence',
        'mediaArtifacts': 'Media evidence',
        'serviceReceipt': 'Authorized service receipt',
      }),
    );
  }
  factory ParsedResult.workflow(ResultJson value) {
    final key = ResultKey.parse(
      'workflow:${resultText(value['id'], maximum: 200)}',
    );
    final status = resultMember(value['status'], [
      'queued',
      'running',
      'waiting_approval',
      'paused',
      'completed',
      'failed',
      'canceled',
    ]);
    final result = value['result'] == null
        ? null
        : resultRecord(value['result']);
    final verification = result?['verification'] == null
        ? null
        : resultRecord(result?['verification']);
    return ParsedResult(
      key: key,
      title: resultText(value['goal']),
      status: status,
      body: _body(
        value['report'] ?? result?['report'] ?? value['error'],
        status,
        workflow: true,
      ),
      meta:
          resultOptionalText(value['currentStep']) ??
          'Current step unavailable',
      timestamp: _timestamp(value, ['completedAt', 'updatedAt', 'createdAt']),
      canonical: value['canonicalStatus'] == null
          ? null
          : ResultCanonical.fromJson(
              value['canonicalStatus'],
              domain: 'workflow_run',
            ),
      grounding: verification == null
          ? 'unavailable'
          : resultText(verification['status']),
      evidence: _evidence(result?['evidenceRefs']),
      metadata: _metadata(
        {...value, 'returnedVerification': ?verification},
        const {
          'workflowType': 'Workflow type',
          'currentStep': 'Current step',
          'attempt': 'Attempt',
          'maxAttempts': 'Attempt limit',
          'returnedVerification': 'Returned verification evidence',
          'approvalRequired': 'Approval required',
          'outcome': 'Outcome receipt',
          'steps': 'Returned workflow steps',
          'plan': 'Returned workflow plan',
          'execution': 'Returned execution metadata',
          'agentIdentity': 'Agent identity receipt',
          'serviceReceipt': 'Authorized service receipt',
        },
      ),
    );
  }
  factory ParsedResult.approval(ResultJson value) {
    final key = ResultKey.parse(
      'approval:${resultText(value['id'], maximum: 200)}',
    );
    final kind = resultMember(value['kind'], [
      'tool',
      'workflow',
      'slo_policy',
    ]);
    final status = resultText(value['status'], maximum: 160);
    return ParsedResult(
      key: key,
      title: resultText(value['title']),
      status: status,
      body:
          resultOptionalText(value['reason']) ??
          'This request is waiting for an operator review.',
      meta:
          '$kind · risk ${value['riskLevel'] == null ? 'unavailable' : resultCount(value['riskLevel'], maximum: 3)}',
      approvalKind: kind,
      timestamp: _timestamp(value, ['updatedAt', 'createdAt']),
      evidence: const [],
      canonical: value['canonicalStatus'] == null
          ? null
          : ResultCanonical.fromJson(
              value['canonicalStatus'],
              domain: kind == 'slo_policy' ? 'slo_policy_change' : 'approval',
            ),
      metadata: _metadata(value, const {
        'kind': 'Approval kind',
        'requestedBy': 'Requesting actor ID',
        'riskLevel': 'Risk',
        'origin': 'Origin identity',
        'record': 'Reviewed tool record',
        'run': 'Reviewed workflow record',
        'change': 'Reviewed policy change',
      }),
    );
  }
  static String _body(Object? value, String status, {required bool workflow}) {
    final body = resultOptionalText(value);
    if (body?.isNotEmpty == true) {
      return body!;
    }
    if (const {'completed', 'failed', 'canceled'}.contains(status)) {
      return workflow
          ? 'No final report was returned for this stored result.'
          : 'No result text was returned for this stored run.';
    }
    return workflow
        ? 'No final report has been returned yet.'
        : 'No final output has been returned yet.';
  }

  static DateTime? _timestamp(ResultJson value, List<String> fields) {
    DateTime? first;
    for (final field in fields) {
      if (value[field] != null) {
        final date = resultDate(value[field]);
        first ??= date;
      }
    }
    return first;
  }

  static List<String> _evidence(Object? value) {
    if (value == null) {
      return const [];
    }
    resultRequire(value is List && value.length <= 512);
    return List.unmodifiable(
      (value as List).map((entry) {
        if (entry is String) {
          return resultText(entry);
        }
        final record = resultRecord(entry);
        // Preserve returned source fields, including full quotes and identities.
        // A simple URL-only record remains easy to read and compatible.
        if (record.length == 1 && record['url'] is String) {
          return resultText(record['url']);
        }
        return resultText(const JsonEncoder.withIndent('  ').convert(record));
      }),
    );
  }

  static Map<String, String> _metadata(
    ResultJson value,
    Map<String, String> labels,
  ) => Map.unmodifiable({
    for (final field in labels.entries)
      if (value[field.key] != null)
        field.value: value[field.key] is String
            ? resultText(value[field.key], empty: true)
            : resultText(
                const JsonEncoder.withIndent('  ').convert(value[field.key]),
              ),
  });
}
