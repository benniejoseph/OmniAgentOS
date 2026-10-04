/// Capture transport is untrusted. These projections preserve the returned
/// identities and distinguish transfer, extraction and indexing evidence.
Map<String, dynamic> captureRecord(Object? value) {
  if (value is! Map<String, dynamic>) {
    throw const FormatException('Capture returned incomplete metadata.');
  }
  return value;
}

String captureText(Object? value, {int maximum = 240, bool empty = false}) {
  if (value is! String ||
      value.length > maximum ||
      (!empty && value.trim().isEmpty)) {
    throw const FormatException('Capture returned an invalid text field.');
  }
  return value;
}

String? captureOptionalText(Object? value, {int maximum = 20000}) =>
    value == null ? null : captureText(value, maximum: maximum, empty: true);
String? captureOptionalId(Object? value) =>
    value == null ? null : captureText(value);
String captureMember(Object? value, Set<String> choices) {
  if (value is! String || !choices.contains(value)) {
    throw const FormatException('Capture returned an unsupported state.');
  }
  return value;
}

const captureJobStates = {
  'queued',
  'running',
  'completed',
  'failed',
  'canceled',
};
String? captureProgressStage(Object? value) {
  if (value == null) {
    return null;
  }
  return captureOptionalText(captureRecord(value)['stage'], maximum: 120);
}

class CaptureAssetSnapshot {
  const CaptureAssetSnapshot({
    required this.id,
    required this.tenantId,
    required this.actorId,
    required this.filename,
    required this.mediaType,
    required this.byteCount,
    required this.contentSha256,
    required this.status,
    required this.extractionStatus,
    this.ingestJobId,
    this.documentId,
    this.error,
    this.contentAvailable = false,
  });
  final String id,
      tenantId,
      actorId,
      filename,
      mediaType,
      contentSha256,
      status,
      extractionStatus;
  final int byteCount;
  final String? ingestJobId, documentId, error;
  final bool contentAvailable;
  String get source => 'capture:asset:$id';
  String get contentIdentity => '$id:$contentSha256:$byteCount';
  bool get indexed => status == 'indexed' && documentId != null;
  String get extractionLabel => switch (extractionStatus) {
    'completed' => 'Extraction completed',
    'partial' => 'Extraction partial',
    'unsupported' => 'Extraction unsupported',
    'failed' => 'Extraction failed',
    _ => 'Extraction pending',
  };
  String get indexingLabel => indexed
      ? 'Indexed document: $documentId'
      : status == 'unsupported'
      ? 'Indexing unavailable for this file'
      : status == 'failed'
      ? 'Indexing failed'
      : 'Indexing not confirmed';
  factory CaptureAssetSnapshot.fromJson(Object? value) {
    final row = captureRecord(value), count = row['byteCount'];
    if (count is! int || count < 1 || count > 5 * 1024 * 1024) {
      throw const FormatException(
        'Capture returned an invalid original byte count.',
      );
    }
    final hash = captureText(row['contentSha256'], maximum: 64);
    if (!RegExp(r'^[a-f0-9]{64}$').hasMatch(hash)) {
      throw const FormatException(
        'Capture returned an invalid content identity.',
      );
    }
    final filename = captureText(row['filename']);
    if (filename.contains('/') ||
        filename.contains('\\') ||
        RegExp(r'[\u0000-\u001f\u007f]').hasMatch(filename)) {
      throw const FormatException(
        'Capture returned an invalid original filename.',
      );
    }
    if (row['contentAvailable'] != null && row['contentAvailable'] is! bool) {
      throw const FormatException(
        'Capture returned an invalid content capability.',
      );
    }
    return CaptureAssetSnapshot(
      id: captureText(row['id']),
      tenantId: captureText(row['tenantId']),
      actorId: captureText(row['actorId']),
      filename: filename,
      mediaType: captureText(row['mediaType'], maximum: 160),
      byteCount: count,
      contentSha256: hash,
      status: captureMember(row['status'], const {
        'stored',
        'queued',
        'indexed',
        'unsupported',
        'failed',
      }),
      extractionStatus: captureMember(row['extractionStatus'], const {
        'pending',
        'completed',
        'partial',
        'unsupported',
        'failed',
      }),
      ingestJobId: captureOptionalId(row['ingestJobId']),
      documentId: captureOptionalId(row['knowledgeDocumentId']),
      error: captureOptionalText(row['error']),
      contentAvailable: row['contentAvailable'] == true,
    );
  }
}

String captureProcessingDescription(String? stage) => switch (stage) {
  'completed' =>
    'Processing job completed. Extraction and indexing are shown separately.',
  'failed' ||
  'canceled' => 'Processing stopped. Review the exact source before retrying.',
  'reading' => 'Original bytes are being read.',
  'extracting' => 'Extraction is running. Indexing is not yet confirmed.',
  'indexing' ||
  'embedding' ||
  'ingesting' => 'Indexing is running. Completion is not yet confirmed.',
  'queued' || null => 'Transferred. Waiting for server processing.',
  _ => 'Server stage: $stage. Completion is not yet confirmed.',
};
