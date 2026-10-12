import 'package:flutter/material.dart';

import '../../app/mobile/mobile_page_scaffold.dart';
import '../../app/platform/mobile_presentation.dart';

class ConnectionFlowHeading extends StatelessWidget {
  const ConnectionFlowHeading({
    super.key,
    required this.title,
    required this.mobileTitle,
    required this.icon,
  });
  final String title, mobileTitle;
  final IconData icon;
  @override
  Widget build(BuildContext context) {
    if (!usesMobilePresentation())
      return Text(title, style: Theme.of(context).textTheme.headlineSmall);
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: MobileSurface(
        child: Row(
          children: [
            Icon(icon, size: 30),
            const SizedBox(width: 16),
            Expanded(
              child: Text(
                mobileTitle,
                style: Theme.of(context).textTheme.titleLarge,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class ConnectionReviewGroup extends StatelessWidget {
  const ConnectionReviewGroup({super.key, required this.children});
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 16),
    child: MobileSurface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final child in children)
            Padding(padding: const EdgeInsets.only(bottom: 12), child: child),
        ],
      ),
    ),
  );
}
