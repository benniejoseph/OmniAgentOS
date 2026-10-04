import 'package:flutter/material.dart';

import 'results.dart';
import 'result_workspaces.dart';

class MacosResultDetailView extends StatelessWidget {
  const MacosResultDetailView({
    super.key,
    required this.keyValue,
    required this.repository,
    this.approvalKind,
    this.onOpenInbox,
    this.onReturnToWork,
  });
  final String keyValue;
  final ResultsRepository repository;
  final String? approvalKind;
  final VoidCallback? onOpenInbox, onReturnToWork;
  @override
  Widget build(BuildContext context) => ResultDetailWorkspace(
    keyValue: keyValue,
    repository: repository,
    approvalKind: approvalKind,
    onOpenInbox: onOpenInbox,
    onReturnToWork: onReturnToWork,
  );
}
