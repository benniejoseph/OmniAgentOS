import 'package:flutter/material.dart';

import 'meetings.dart';
import 'meetings_form_model.dart';
import 'meetings_validation.dart';
import 'meetings_widgets.dart';

class MeetingRelationshipFields extends StatelessWidget {
  const MeetingRelationshipFields({
    super.key,
    required this.definition,
    required this.enabled,
    required this.onChanged,
  });
  final Json definition;
  final bool enabled;
  final ValueChanged<Json> onChanged;

  List<Json> _rows(String name) =>
      (definition[name] as List).map(meetingMap).toList();
  void _replace(String name, int index, Json value) {
    if (!enabled) {
      return;
    }
    final rows = _rows(name);
    rows[index] = value;
    onChanged({name: rows});
  }

  void _remove(String name, int index) {
    if (!enabled) {
      return;
    }
    final rows = _rows(name)..removeAt(index);
    onChanged({name: rows});
  }

  @override
  Widget build(BuildContext context) {
    final participants = _rows('participants'),
        entities = _rows('entityLinks'),
        sources = _rows('sourceLinks');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        MeetingSection(
          'Participants and consent',
          subtitle: 'Record consent only when you have verified it. Adding a participant does not send an invitation or grant consent.',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (var index = 0; index < participants.length; index++)
                _participant(participants[index], index),
              if (participants.isEmpty) const Text('No participants added.'),
              OutlinedButton.icon(
                key: const Key('meeting-add-participant'),
                onPressed: enabled && participants.length < 250
                    ? () => onChanged({
                        'participants': [
                          ...participants,
                          newMeetingParticipantDraft(),
                        ],
                      })
                    : null,
                icon: const Icon(Icons.person_add_outlined),
                label: const Text('Add participant'),
              ),
              Text('${participants.length} of 250 participants'),
            ],
          ),
        ),
        MeetingSection(
          'Linked source references',
          subtitle: 'Exact source identities are retained and checked again on save. Linking or editing a reference does not process media or change Calendar.',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (var index = 0; index < sources.length; index++)
                _source(sources[index], index),
              if (sources.isEmpty) const Text('No source references linked.'),
              const Text(
                'Use the web Meeting editor to choose additional governed Library sources. Source selection is not available in this native version.',
              ),
            ],
          ),
        ),
        MeetingSection(
          'Customer and account context',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (var index = 0; index < entities.length; index++)
                _entity(entities[index], index),
              if (entities.isEmpty)
                const Text('No Entity Registry records linked.'),
              const Text(
                'Use the web Meeting editor to choose additional Entity Registry records. Existing record identities and types remain fixed here.',
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _participant(Json row, int index) {
    final id = row['participantId'] as String;
    final referenced = meetingRelationshipReferenced(
      definition,
      'ownerParticipantId',
      id,
    );
    void change(Json fields) => _replace(
      'participants',
      index,
      updateMeetingParticipantDraft(row, fields),
    );
    return MeetingDisclosure(
      'Participant ${index + 1}: ${(row['displayName'] as String).isEmpty ? 'New participant' : row['displayName']}',
      key: ValueKey('participant:$id'),
      expanded: (row['displayName'] as String).isEmpty,
      children: [
        _text(
          'participant-name:$id',
          'Participant name',
          row['displayName'] as String,
          160,
          (value) => change({'displayName': value}),
        ),
        _text(
          'participant-email:$id',
          'Participant email · optional',
          row['email'] as String? ?? '',
          320,
          (value) => change({'email': value.trim().isEmpty ? null : value}),
          required: false,
          email: true,
        ),
        _choice(
          'participant-role:$id',
          'Participant role',
          row['role'] as String,
          meetingParticipantRoles,
          (value) => change({'role': value}),
        ),
        _choice(
          'participant-response:$id',
          'Participant response',
          row['response'] as String,
          meetingParticipantResponses,
          (value) => change({'response': value}),
        ),
        _choice(
          'participant-attendee:$id',
          'Attendee consent',
          row['attendeeConsent'] as String,
          meetingAttendeeConsentStates,
          (value) => change({'attendeeConsent': value}),
        ),
        _choice(
          'participant-recording:$id',
          'Recording consent',
          row['recordingConsent'] as String,
          meetingRecordingConsentStates,
          (value) => change({'recordingConsent': value}),
        ),
        MeetingValue(
          'Consent recorded at',
          row['consentCapturedAt'] as String? ?? 'No explicit consent recorded',
        ),
        MeetingValue(
          'Participant origin',
          meetingLabel(row['source'] as String),
        ),
        if (row['entityId'] != null)
          MeetingValue('Existing person reference', row['entityId'] as String),
        if (referenced)
          const Text(
            'A recorded decision or commitment references this participant. Keep that exact reference until the recorded outcome is revised.',
          ),
        TextButton.icon(
          key: ValueKey('participant-remove:$id'),
          onPressed: enabled && !referenced
              ? () => _remove('participants', index)
              : null,
          icon: const Icon(Icons.person_remove_outlined),
          label: const Text('Remove participant'),
        ),
      ],
    );
  }

  Widget _source(Json row, int index) {
    final id = row['linkId'] as String, kind = row['kind'] as String;
    final referenced = meetingRelationshipReferenced(
      definition,
      'sourceLinkId',
      id,
    );
    return MeetingDisclosure(
      row['label'] as String,
      key: ValueKey('source:$id'),
      children: [
        MeetingValue('Source type', meetingLabel(kind)),
        MeetingValue('Source identity', row['sourceId'] as String),
        MeetingValue(
          'Exact revision',
          row['sourceRevisionId'] as String? ??
              'Current Capture snapshot is resolved again on save',
        ),
        _text(
          'source-label:$id',
          'Source label',
          row['label'] as String,
          240,
          (value) => _replace('sourceLinks', index, {...row, 'label': value}),
        ),
        _choice(
          'source-role:$id',
          'Source role',
          row['mediaRole'] as String,
          meetingSourceRoleChoices(kind),
          (value) =>
              _replace('sourceLinks', index, {...row, 'mediaRole': value}),
        ),
        if (referenced)
          const Text(
            'A recorded decision or commitment references this source. Its exact link cannot be removed here.',
          ),
        TextButton.icon(
          key: ValueKey('source-remove:$id'),
          onPressed: enabled && !referenced
              ? () => _remove('sourceLinks', index)
              : null,
          icon: const Icon(Icons.link_off),
          label: const Text('Remove source reference'),
        ),
      ],
    );
  }

  Widget _entity(Json row, int index) {
    final id = row['entityId'] as String;
    return MeetingDisclosure(
      row['label'] as String,
      key: ValueKey('entity:$id'),
      children: [
        MeetingValue('Entity Registry record', id),
        MeetingValue('Record type', meetingLabel(row['entityType'] as String)),
        _text(
          'entity-label:$id',
          'Context label',
          row['label'] as String,
          240,
          (value) => _replace('entityLinks', index, {...row, 'label': value}),
        ),
        _choice(
          'entity-relationship:$id',
          'Relationship to this meeting',
          row['relationship'] as String,
          meetingEntityRelationships,
          (value) =>
              _replace('entityLinks', index, {...row, 'relationship': value}),
        ),
        TextButton.icon(
          key: ValueKey('entity-remove:$id'),
          onPressed: enabled ? () => _remove('entityLinks', index) : null,
          icon: const Icon(Icons.link_off),
          label: const Text('Remove entity link'),
        ),
      ],
    );
  }

  Widget _text(
    String key,
    String label,
    String value,
    int maximum,
    ValueChanged<String> change, {
    bool required = true,
    bool email = false,
  }) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: TextFormField(
      key: ValueKey(key),
      initialValue: value,
      enabled: enabled,
      maxLength: maximum,
      keyboardType: email ? TextInputType.emailAddress : TextInputType.text,
      decoration: InputDecoration(labelText: label),
      onChanged: change,
      validator: (value) => required && (value == null || value.trim().isEmpty)
          ? '$label is required.'
          : null,
    ),
  );
  Widget _choice(
    String key,
    String label,
    String value,
    List<String> values,
    ValueChanged<String> change,
  ) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: DropdownButtonFormField<String>(
      key: ValueKey('$key:$value'),
      initialValue: value,
      isExpanded: true,
      decoration: InputDecoration(labelText: label),
      items: [
        for (final choice in values)
          DropdownMenuItem(value: choice, child: Text(meetingLabel(choice))),
      ],
      onChanged: enabled
          ? (value) {
              if (value != null) {
                change(value);
              }
            }
          : null,
    ),
  );
}
