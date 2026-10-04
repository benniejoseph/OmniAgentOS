import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../generated/native_contract.g.dart';
import 'agent_skill_contracts.dart';
import 'specialist_api_client.dart';
import 'specialist_contracts.dart';

final agentSkillControllerProvider =
    ChangeNotifierProvider.autoDispose<AgentSkillController>((ref) {
      final controller = AgentSkillController(
        ref.watch(specialistApiProvider('agents')),
      );
      unawaited(controller.initialize());
      return controller;
    });

class AgentSkillController extends ChangeNotifier {
  AgentSkillController(this.client);
  final SpecialistApiClient client;
  AgentSkillIntent? pending, acceptedIntent, notSubmitted;
  AgentSkillAcceptance? accepted;
  bool busy = false, loaded = false, needsLocalSave = false, _disposed = false;
  String? error;
  Future<void>? _initializing;
  bool get current => !_disposed && client.current;
  AgentSkillOwner get owner => AgentSkillOwner.fromAccess(client.access!);
  bool canWrite(String operation) =>
      current &&
      loaded &&
      !busy &&
      !needsLocalSave &&
      pending == null &&
      client.nativeDecisionAvailable &&
      client.access!.canManage &&
      NativeContract.supportsOperation(switch (operation) {
        'agent.delete' => 'agents.delete',
        'skill.create' => 'skills.create',
        'skill.update' => 'skills.update',
        _ => 'skills.delete',
      });
  void _emit() {
    if (!_disposed) {
      notifyListeners();
    }
  }

  Future<void> initialize() => _initializing ??= _restore();
  Future<void> _restore() async {
    try {
      await client.initialize();
      if (!current) {
        return;
      }
      specialistRequire(
        client.recoveryError == null,
        client.recoveryError ?? 'Recovery unavailable.',
      );
      await _load(client.nativeDecision);
      if (current) {
        loaded = true;
      }
    } catch (_) {
      if (current) {
        error =
            'Protected catalog recovery is unavailable. New changes are held.';
      }
    }
    _emit();
  }

  Future<void> _load(SpecialistJson? value) async {
    final knownPending = pending,
        knownIntent = acceptedIntent,
        knownAccepted = accepted;
    AgentSkillIntent? nextPending, nextIntent, nextNotSubmitted;
    AgentSkillAcceptance? nextAccepted;
    if (value != null) {
      final row = agentSkillExact(value, {
        'pending',
        'acceptedIntent',
        'accepted',
        'notSubmitted',
      });
      if (row['pending'] != null) {
        nextPending = await AgentSkillIntent.restore(row['pending'], owner);
      }
      specialistRequire(
        (row['acceptedIntent'] == null) == (row['accepted'] == null),
      );
      if (row['acceptedIntent'] != null) {
        nextIntent = await AgentSkillIntent.restore(
          row['acceptedIntent'],
          owner,
        );
        nextAccepted = await AgentSkillAcceptance.restore(
          row['accepted'],
          owner,
          nextIntent,
        );
      }
      if (row['notSubmitted'] != null) {
        nextNotSubmitted = await AgentSkillIntent.restore(
          row['notSubmitted'],
          owner,
        );
      }
    }
    if (!current) {
      return;
    }
    bool same(AgentSkillIntent? a, AgentSkillIntent? b) =>
        a != null &&
        b != null &&
        a.key == b.key &&
        a.requestSha256 == b.requestSha256;
    specialistRequire(
      knownPending == null ||
          same(knownPending, nextPending) ||
          same(knownPending, nextIntent),
      'The unresolved exact decision is absent from storage. It remains held.',
    );
    if (knownAccepted != null &&
        knownIntent != null &&
        (same(knownIntent, nextPending) ||
            needsLocalSave && !same(knownIntent, nextIntent))) {
      specialistRequire(
        nextPending == null || same(knownIntent, nextPending),
        'Another protected decision occupies this journal.',
      );
      pending = null;
      acceptedIntent = knownIntent;
      accepted = knownAccepted;
      needsLocalSave = true;
    } else {
      pending = nextPending;
      acceptedIntent = nextIntent;
      accepted = nextAccepted;
      needsLocalSave = false;
    }
    notSubmitted = nextNotSubmitted;
  }

  SpecialistJson _journal() => specialistFreeze({
    'pending': pending?.toJson(),
    'acceptedIntent': acceptedIntent?.toJson(),
    'accepted': accepted?.toJson(),
    'notSubmitted': notSubmitted?.toJson(),
  });
  Future<void> reload() async {
    if (!current || busy) {
      return;
    }
    busy = true;
    error = null;
    _emit();
    try {
      await client.reloadRecovery();
      if (!current) {
        return;
      }
      specialistRequire(client.recoveryError == null);
      await _load(client.nativeDecision);
      if (current) {
        loaded = true;
      }
    } catch (_) {
      if (current) {
        loaded = false;
        error = 'Protected recovery could not be reconciled. The exact pending decision and any accepted receipt remain held.';
      }
    } finally {
      if (current) {
        busy = false;
        _emit();
      }
    }
  }

  Future<AgentSkillReview> review(String operation, String id) async {
    specialistRequire(current && client.access!.canManage);
    agentSkillId(id);
    final path = operation == 'agent.delete'
        ? NativePaths.agentsDeleteReview(id)
        : NativePaths.skillsMutationReview(
            id,
            operation: operation == 'skill.update' ? 'update' : 'delete',
          );
    final response = await client.getJsonFresh(path);
    specialistRequire(current);
    final value = await AgentSkillReview.parse(response, owner, operation, id);
    specialistRequire(current);
    return value;
  }

  Future<void> submit(
    SpecialistJson request, {
    required bool Function() isCurrent,
  }) async {
    final operation = request['contract'] == 'asael-skill-create:1'
        ? 'skill.create'
        : specialistMap(request['review'])['operation'] as String;
    if (!canWrite(operation) || !isCurrent()) {
      return;
    }
    busy = true;
    error = null;
    _emit();
    try {
      await client.withNativeDecision(() async {
        final intent = await AgentSkillIntent.prepare(
          owner,
          'native-catalog-${List<int>.generate(24, (_) => Random.secure().nextInt(256)).map((value) => value.toRadixString(16).padLeft(2, '0')).join()}',
          request,
        );
        if (!current || !isCurrent()) {
          return;
        }
        if (intent.request['preview'] != null) {
          specialistRequire(
            DateTime.parse(intent.request['preview']['expiresAt'] as String)
                .isAfter(DateTime.now().toUtc()),
            'The deletion review expired. Refresh it before deciding.',
          );
        }
        pending = intent;
        notSubmitted = null;
        await client.saveNativeDecision(_journal());
        if (!current) {
          return;
        }
        if (!isCurrent()) {
          pending = null;
          notSubmitted = intent;
          try {
            await client.saveNativeDecision(_journal());
          } catch (_) {
            pending = intent;
            notSubmitted = null;
            rethrow;
          }
          return;
        }
        // Once dispatched, only an exact authenticated receipt read can settle
        // uncertainty. A timeout, refusal or later resource read never retries.
        final response = await client.dispatchNativeDecision(
          intent,
          isCurrent: isCurrent,
        );
        if (!current) {
          return;
        }
        final receipt = await AgentSkillAcceptance.parse(
          response,
          owner,
          intent,
          mutation: true,
        );
        if (!current) {
          return;
        }
        specialistRequire(receipt != null);
        pending = null;
        acceptedIntent = intent;
        accepted = receipt;
        needsLocalSave = true;
        _emit();
        await client.saveNativeDecision(_journal());
        if (current) {
          needsLocalSave = false;
        }
      });
    } catch (_) {
      if (current) {
        error = accepted != null && needsLocalSave
            ? 'The decision was accepted. Its protected local receipt still needs saving.'
            : pending != null
            ? 'The outcome is unconfirmed. Check the exact receipt; this request will not be sent again.'
            : 'The change could not be prepared. Refresh the exact review before trying again.';
      }
    } finally {
      if (current) {
        busy = false;
        _emit();
      }
    }
  }

  Future<void> recover() async {
    final intent = pending;
    if (!current ||
        busy ||
        !loaded ||
        intent == null ||
        client.recoveryError != null) {
      return;
    }
    busy = true;
    error = null;
    _emit();
    try {
      await client.withNativeDecision(() async {
        final path = intent.operation == 'agent.delete'
            ? NativePaths.agentsMutationsGet(intent.keySha256)
            : NativePaths.skillsMutationsGet(intent.keySha256);
        final response = await client.getJsonFresh(path);
        if (!current) {
          return;
        }
        final receipt = await AgentSkillAcceptance.parse(
          response,
          owner,
          intent,
          mutation: false,
        );
        if (!current) {
          return;
        }
        if (receipt == null) {
          error = 'No matching receipt is available. The original decision remains unconfirmed.';
          return;
        }
        pending = null;
        acceptedIntent = intent;
        accepted = receipt;
        needsLocalSave = true;
        _emit();
        await client.saveNativeDecision(_journal());
        if (current) {
          needsLocalSave = false;
        }
      }, recovery: true);
    } catch (_) {
      if (current) {
        error = needsLocalSave
            ? 'The accepted decision is retained here. Reload protected recovery, then save its receipt locally.'
            : 'The exact receipt is unavailable. The original decision remains unconfirmed.';
      }
    } finally {
      if (current) {
        busy = false;
        _emit();
      }
    }
  }

  Future<void> settleLocally() async {
    if (!current ||
        busy ||
        !loaded ||
        pending != null ||
        accepted == null ||
        !needsLocalSave ||
        client.recoveryError != null) {
      return;
    }
    busy = true;
    error = null;
    _emit();
    try {
      await client.withNativeDecision(
        () => client.saveNativeDecision(_journal()),
        recovery: true,
      );
      if (current) {
        needsLocalSave = false;
      }
    } catch (_) {
      if (current) {
        error = 'The accepted receipt is retained, but its protected save remains unconfirmed.';
      }
    } finally {
      if (current) {
        busy = false;
        _emit();
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    pending = null;
    acceptedIntent = null;
    accepted = null;
    notSubmitted = null;
    super.dispose();
  }
}
