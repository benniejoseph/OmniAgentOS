/// Presentation only. These labels never select a tool or authorize its inputs.
({String summary, String? detail}) voiceApprovalPresentation(Map action) {
  final input = action['input'];
  if (input is Map) {
    if (action['toolId'] == 'local.macos.click' &&
        input['interactionPurpose'] == 'media_control' &&
        _validClick(input)) {
      return (
        summary: 'Click the selected media control on This Mac',
        detail: 'The action does not identify the control by name. Check Exact action details if the selected control is unclear.',
      );
    }
    if (action['toolId'] == 'local.macos.activate_app' &&
        input.keys.every(const {'bundleId', 'launchIfNeeded'}.contains) &&
        input['bundleId'] is String &&
        (!input.containsKey('launchIfNeeded') ||
            input['launchIfNeeded'] is bool)) {
      final name = const {
        'com.google.Chrome': 'Google Chrome',
        'com.apple.Safari': 'Safari',
        'org.mozilla.firefox': 'Firefox',
        'com.microsoft.edgemac': 'Microsoft Edge',
      }[input['bundleId']];
      if (name != null) {
        return (
          summary: 'Bring $name to the front on This Mac',
          detail: input['launchIfNeeded'] == true
              ? '$name will open if it is not already running.'
              : 'This action switches to the running app.',
        );
      }
    }
  }
  final title = action['title'];
  return (
    summary: title is String && title.trim().isNotEmpty && title.length <= 240
        ? title
        : 'Review the proposed action',
    detail: 'Review the exact action details before deciding.',
  );
}

bool _validClick(Map input) {
  if (!input.keys.every(
        const {
          'snapshotRevision',
          'interactionPurpose',
          'elementId',
          'x',
          'y',
          'coordinateSpace',
        }.contains,
      ) ||
      input['snapshotRevision'] is! String ||
      !RegExp(r'^[a-f0-9]{64}$')
          .hasMatch(input['snapshotRevision'] as String)) {
    return false;
  }
  if (input.containsKey('elementId')) {
    return input['elementId'] is String &&
        RegExp(r'^[A-Za-z0-9_.:-]{3,120}$')
            .hasMatch(input['elementId'] as String) &&
        !input.containsKey('x') &&
        !input.containsKey('y') &&
        !input.containsKey('coordinateSpace');
  }
  bool pixel(Object? value) =>
      value is num && value.isFinite && value >= 0 && value <= 32768;
  return input['coordinateSpace'] == 'screenshot_pixel' &&
      pixel(input['x']) &&
      pixel(input['y']);
}
