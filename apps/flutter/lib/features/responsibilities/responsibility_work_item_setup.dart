import 'responsibility_contracts.dart';

/// Prepares an editable draft only. Saving, reviewing, activating checks and
/// enabling notices remain separate verified server actions.
ResponsibilityJson workItemFollowthroughDraft({
  required ResponsibilityJson draft,
  required ResponsibilityJson work,
  required DateTime now,
}) {
  final earliest = now.toUtc().add(const Duration(minutes: 5));
  final minute = DateTime.utc(
    earliest.year,
    earliest.month,
    earliest.day,
    earliest.hour,
    earliest.minute,
  );
  // The scheduler requires whole minutes. Round up so preparation still leaves
  // at least five minutes for review, including across midnight.
  final start = earliest == minute
      ? minute
      : minute.add(const Duration(minutes: 1));
  final reference = {
    for (final field in ['workspaceId', 'projectId', 'workItemId'])
      field: work[field],
  };
  final label = work['label'] as String;
  final result = <String, dynamic>{
    ...draft,
    'purpose': (draft['purpose'] as String).isEmpty
        ? 'Follow up: $label'
        : draft['purpose'],
    'desiredOutcome': (draft['desiredOutcome'] as String).isEmpty
        ? 'Keep this commitment moving and tell me when something needs attention.'
        : draft['desiredOutcome'],
    'successCondition': (draft['successCondition'] as String).isEmpty
        ? 'I know about material changes and can review the linked outputs. Marked done does not mean independently verified.'
        : draft['successCondition'],
    'stopConditions': (draft['stopConditions'] as List).isEmpty
        ? ['The tracking period expires or I stop tracking.']
        : draft['stopConditions'],
    'work': reference,
    'sources': [
      {
        'kind': 'work_item',
        'id': reference['workItemId'],
        'workspaceId': reference['workspaceId'],
        'projectId': reference['projectId'],
      },
    ],
    'procedureId': responsibilityWorkItemProcedure,
    'agentId': draft['agentId'] ?? 'atlas',
    'cadence':
        draft['cadence'] ??
        {
          'frequency': 'daily',
          'interval': 1,
          'timezone': 'UTC',
          'startsAt': start.toIso8601String(),
          'expiresAt': start.add(const Duration(days: 7)).toIso8601String(),
          'missedPolicy': 'skip',
        },
    'limits':
        draft['limits'] ??
        {
          'maxChecks': 7,
          'maxNotifications': 7,
          'cumulative': {
            for (final field in responsibilityBudgetDimensions)
              field: field == 'wallTimeMs'
                  ? 210000
                  : field == 'toolCalls' || field == 'agents'
                  ? 7
                  : 0,
          },
        },
    'notificationRule':
        draft['notificationRule'] ??
        {
          'kind': 'material_change_only',
          'destination': 'owner_in_app',
          'quietOnNoChange': true,
        },
  };
  validateResponsibilityDraft(result);
  return result;
}
