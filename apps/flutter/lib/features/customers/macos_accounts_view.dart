import 'package:flutter/material.dart';

import '../../core/network/api_client.dart';
import 'accounts_contracts.dart';
import 'accounts_workspace.dart';

class MacosAccountsView extends StatelessWidget {
  const MacosAccountsView({super.key, required this.api, required this.onOpen});
  final ApiClient api;
  final ValueChanged<CustomerAccountSummary> onOpen;
  @override
  Widget build(BuildContext context) =>
      NativeAccountsView(expectedApi: api, onOpen: onOpen);
}
