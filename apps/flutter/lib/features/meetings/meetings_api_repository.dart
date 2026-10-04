import 'package:dio/dio.dart';

import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'meetings.dart';
import 'meetings_access.dart';
import 'meetings_commitments.dart';
import 'meetings_snapshots.dart';
import 'meetings_mutations.dart';
import 'meetings_validation.dart';

abstract interface class LiveMeetingsRepository implements MeetingsRepository {
  MeetingsAccess get access;
  bool authorityCurrent();
  Future<MeetingsSnapshot> listSnapshot(
    CancelToken cancel, {
    String? workspaceId,
  });
  Future<MeetingDetailSnapshot> detailSnapshot(
    String id,
    CancelToken cancel, {
    String? workspaceId,
  });
  Future<MeetingCommitmentsSnapshot> commitmentsSnapshot(
    String id,
    CancelToken cancel, {
    String? workspaceId,
  });
}

abstract interface class MutatingMeetingsRepository
    implements LiveMeetingsRepository {
  Future<Json> mutate(MeetingSubmission submitted);
}

class ApiMeetingsRepository implements MutatingMeetingsRepository {
  ApiMeetingsRepository(
    this.api, {
    required this.access,
    required bool Function() authorityProbe,
  }) : _probe = authorityProbe {
    access.addListener(_changed);
  }
  final ApiClient api;
  @override
  final MeetingsAccess access;
  final bool Function() _probe;
  final Set<CancelToken> _reads = {};
  bool _disposed = false;
  bool _writeBusy = false;
  void _changed() {
    for (final token in _reads.toList()) {
      token.cancel('Meeting access changed.');
    }
  }

  @override
  bool authorityCurrent() =>
      !_disposed &&
      access.readable &&
      _probe() &&
      !_disposed &&
      access.readable;
  Future<Json> _read(
    String path,
    CancelToken cancel,
    Json query, {
    required bool available,
    required String operation,
  }) async {
    if (!authorityCurrent() || !available) {
      throw StateError(
        'This native Meeting read is not available for the current session.',
      );
    }
    final generation = access.generation;
    _reads.add(cancel);
    try {
      final value = await api.getJsonFreshCancelable(
        path,
        query: query,
        cancelToken: cancel,
      );
      final receipt = meetingMap(value['serviceReceipt']);
      meetingRequire(
        receipt['schemaVersion'] == 1 &&
            receipt['receiptKind'] == 'app_service_receipt' &&
            receipt['boundaryVersion'] == 'p9.1-app-service-boundary:1' &&
            receipt['operation'] == operation &&
            receipt['action'] == 'read' &&
            receipt['accessMode'] == 'read' &&
            receipt['resourceType'] ==
                (operation == 'app.meetings.commitments.list'
                    ? 'meeting_commitment'
                    : 'meeting') &&
            receipt['eventContract'] == 'read_only:no_domain_mutation' &&
            receipt['idempotencyKeySha256'] == null,
      );
      meetingHash(receipt['authoritySha256']);
      meetingInt(receipt['resourceCount'], maximum: 1000000);
      meetingInstant(receipt['occurredAt']);
      final receiptBody = {...receipt}..remove('receiptSha256'),
          body = {...value}..remove('serviceReceipt');
      meetingRequire(
        receipt['receiptSha256'] == await meetingSha(receiptBody) &&
            receipt['outcomeSha256'] == await meetingSha(body),
        'The read receipt does not match its returned Meeting data.',
      );
      if (!authorityCurrent() ||
          generation != access.generation ||
          cancel.isCancelled) {
        throw StateError('Meeting access changed during the read.');
      }
      return value;
    } finally {
      _reads.remove(cancel);
    }
  }

  Json _query(String? workspaceId) => {
    if (workspaceId != null) 'workspaceId': meetingId(workspaceId),
  };
  @override
  Future<MeetingsSnapshot> listSnapshot(
    CancelToken cancel, {
    String? workspaceId,
  }) async {
    final owner = access.owner, generation = access.generation;
    final value = await _read(
      NativePaths.meetingsList(),
      cancel,
      {..._query(workspaceId), 'limit': 100},
      available: access.listAvailable,
      operation: 'app.meetings.list',
    );
    final snapshot = MeetingsSnapshot.parse(
      value,
      tenantId: owner!.tenantId,
      workspaceId: workspaceId,
    );
    for (final meeting in snapshot.meetings) {
      await verifyMeetingRevision(meeting);
    }
    if (!authorityCurrent() ||
        generation != access.generation ||
        cancel.isCancelled) {
      throw StateError('Meeting read scope changed.');
    }
    return snapshot;
  }

  @override
  Future<MeetingDetailSnapshot> detailSnapshot(
    String id,
    CancelToken cancel, {
    String? workspaceId,
  }) async {
    final owner = access.owner, generation = access.generation;
    meetingId(id, max: 240);
    final value = await _read(
      NativePaths.meetingsGet(id),
      cancel,
      _query(workspaceId),
      available: access.detailAvailable,
      operation: 'app.meetings.show',
    );
    final snapshot = MeetingDetailSnapshot.parse(
      value,
      id: id,
      tenantId: owner!.tenantId,
      workspaceId: workspaceId,
    );
    await verifyMeetingRevision(snapshot.meeting);
    for (final source in snapshot.sources) {
      final output = source.media?.output;
      if (output != null) {
        await verifyMeetingDigest(output.raw, 'outputSha256');
        meetingRequire(
          {
            owner.actorId,
            'actor:${owner.userId}',
          }.contains(output.raw['ownerActorId']),
          'The media output belongs to a different current owner.',
        );
      }
    }
    if (!authorityCurrent() ||
        generation != access.generation ||
        cancel.isCancelled) {
      throw StateError('Meeting read scope changed.');
    }
    return snapshot;
  }

  @override
  Future<MeetingCommitmentsSnapshot> commitmentsSnapshot(
    String id,
    CancelToken cancel, {
    String? workspaceId,
  }) async {
    final owner = access.owner, generation = access.generation;
    meetingId(id, max: 240);
    // This read remains gated until its typed operation is published. The path
    // is the existing exact authorized read, with no inferred write capability.
    final value = await _read(
      NativePaths.meetingsCommitmentsList(id),
      cancel,
      _query(workspaceId),
      available: access.commitmentsAvailable,
      operation: 'app.meetings.commitments.list',
    );
    final snapshot = MeetingCommitmentsSnapshot.parse(
      value,
      id: id,
      tenantId: owner!.tenantId,
      workspaceId: workspaceId,
    );
    for (final row in snapshot.rows) {
      await verifyMeetingDigest(row.proposal, 'proposalSha256');
      if (row.resolution != null) {
        await verifyMeetingDigest(row.resolution!, 'resolutionSha256');
      }
    }
    for (final policy in snapshot.policies) {
      meetingRequire(policy['ownerActorId'] == owner.actorId);
      await verifyMeetingDigest(policy, 'policySha256');
    }
    if (!authorityCurrent() ||
        generation != access.generation ||
        cancel.isCancelled) {
      throw StateError('Meeting read scope changed.');
    }
    return snapshot;
  }

  @override
  Future<List<Meeting>> list() async =>
      (await listSnapshot(CancelToken())).meetings;
  @override
  Future<Meeting> detail(String id) async =>
      (await detailSnapshot(id, CancelToken())).meeting;
  @override
  Future<Json> mutate(MeetingSubmission submitted) async {
    final owner = access.owner;
    if (_writeBusy ||
        !authorityCurrent() ||
        owner == null ||
        owner.key != submitted.ownerKey ||
        !owner.canManage ||
        !access.supports(submitted.operation)) {
      throw StateError(
        'The exact native Meeting write is unavailable or another write is pending.',
      );
    }
    _writeBusy = true;
    final generation = access.generation;
    bool current() =>
        authorityCurrent() &&
        access.generation == generation &&
        access.owner?.key == submitted.ownerKey &&
        access.supports(submitted.operation);
    final authority = NativeRequestAuthority(
      tenantId: owner.tenantId,
      actorId: owner.actorId,
      canonicalUserId: owner.userId,
      role: owner.role,
      apiBaseUrl: api.apiBaseUrl,
      isCurrent: current,
    );
    final path = submitted.action == 'create'
        ? NativePaths.meetingsCreate
        : submitted.action == 'propose'
        ? NativePaths.meetingsCommitmentsPropose(submitted.id!)
        : submitted.action == 'resolve'
        ? NativePaths.meetingsCommitmentsResolve(submitted.id!)
        : NativePaths.meetingsUpdate(submitted.id!);
    try {
      final value = const ['create', 'propose'].contains(submitted.action)
          ? await api.postJsonAuthorized(
              path,
              authority: authority,
              data: submitted.body,
              headers: {'Idempotency-Key': submitted.key},
            )
          : await api.patchJsonAuthorized(
              path,
              authority: authority,
              data: submitted.body,
              headers: {'Idempotency-Key': submitted.key},
            );
      if (!current()) {
        throw StateError(
          'The Meeting write owner changed. Its server outcome remains unconfirmed here.',
        );
      }
      return value;
    } finally {
      _writeBusy = false;
    }
  }

  void dispose() {
    if (_disposed) {
      return;
    }
    _disposed = true;
    access.removeListener(_changed);
    _changed();
  }
}
