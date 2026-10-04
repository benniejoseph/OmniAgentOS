import 'package:flutter/material.dart';

import '../../core/network/api_client.dart';
import 'markets_workspace.dart';

/// Compatibility entry: the supplied client must match the live provider.
class MarketsView extends StatelessWidget {
  const MarketsView({super.key, required this.api});
  final ApiClient api;
  @override
  Widget build(BuildContext context) => NativeMarketsView(expectedApi: api);
}
