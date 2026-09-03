import 'package:flutter/material.dart';

class AdminEndpoint {
  const AdminEndpoint(this.label, this.path, {this.description = ''});
  final String label;
  final String path;
  final String description;
}

class AdminAction {
  const AdminAction(this.label, this.path, {this.payload = const {}});
  final String label;
  final String path;
  final Map<String, dynamic> payload;
}

class AdminModule {
  const AdminModule({
    required this.id,
    required this.label,
    required this.description,
    required this.icon,
    required this.endpoints,
    this.actions = const [],
  });
  final String id;
  final String label;
  final String description;
  final IconData icon;
  final List<AdminEndpoint> endpoints;
  final List<AdminAction> actions;
}

class AdminSnapshot {
  const AdminSnapshot(this.values, this.failures, this.updatedAt);
  final Map<String, Map<String, dynamic>> values;
  final Map<String, Object> failures;
  final DateTime updatedAt;
}
