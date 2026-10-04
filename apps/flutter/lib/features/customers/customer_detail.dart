import 'package:flutter/material.dart';

import '../../core/network/api_client.dart';
import 'accounts_workspace.dart';

export 'accounts_contracts.dart' show CustomerDetail, CustomerFact;

class CustomerDetailView extends StatelessWidget {
  const CustomerDetailView({super.key, required this.id, required this.api});
  final String id;
  final ApiClient api;
  @override
  Widget build(BuildContext context) =>
      NativeAccountsView(accountId: id, expectedApi: api);
}
