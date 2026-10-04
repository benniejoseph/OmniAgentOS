import 'package:flutter/material.dart';

import 'results.dart';
import 'result_workspaces.dart';

class ResultsView extends StatelessWidget {
  const ResultsView({
    super.key,
    required this.controller,
    required this.onOpen,
  });
  final ResultsController controller;
  final ValueChanged<ResultItem> onOpen;
  @override
  Widget build(BuildContext context) =>
      ResultsWorkspace(controller: controller, onOpen: onOpen);
}

class ResultDetailView extends StatelessWidget {
  const ResultDetailView({
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
