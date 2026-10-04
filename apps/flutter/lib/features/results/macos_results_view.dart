import 'package:flutter/material.dart';

import 'results.dart';
import 'result_workspaces.dart';

class MacosResultsView extends StatelessWidget {
  const MacosResultsView({
    super.key,
    required this.controller,
    required this.onOpen,
  });
  final ResultsController controller;
  final ValueChanged<ResultItem> onOpen;
  @override
  Widget build(BuildContext context) =>
      ResultsWorkspace(controller: controller, onOpen: onOpen, desktop: true);
}
