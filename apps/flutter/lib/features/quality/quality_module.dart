import 'package:flutter/material.dart';

import '../settings/admin_models.dart';

const qualityModule = AdminModule(
  id: 'quality',
  label: 'Quality',
  icon: Icons.fact_check_outlined,
  description: 'Evaluation results and production release evidence.',
  endpoints: [
    AdminEndpoint('Evaluations', '/api/evaluations'),
    AdminEndpoint('Release evidence', '/api/release/evidence'),
  ],
);
