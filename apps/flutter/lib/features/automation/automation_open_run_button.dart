import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../results/result_contracts.dart';

/// Opens the existing authorized Results detail while retaining Automation.
class AutomationOpenRunButton extends StatelessWidget {
  const AutomationOpenRunButton({super.key, required this.resultKey});

  final ResultKey resultKey;

  @override
  Widget build(BuildContext context) => TextButton.icon(
    onPressed: () =>
        context.push('/results/${Uri.encodeComponent(resultKey.value)}'),
    icon: const Icon(Icons.arrow_forward_rounded, size: 16),
    label: const Text('Open run'),
  );
}
