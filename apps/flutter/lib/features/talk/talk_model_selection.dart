import 'package:flutter/foundation.dart';

const _supportedModelProviders = {
  'openai',
  'google',
  'anthropic',
  'aws_bedrock',
};
const _supportedReasoningLevels = {
  'low',
  'medium',
  'high',
  'extra_high',
  'ultra',
};

@immutable
class TalkCommandReasoningOption {
  const TalkCommandReasoningOption({
    required this.id,
    required this.label,
  });

  final String id;
  final String label;

  factory TalkCommandReasoningOption.fromJson(Object? value) {
    if (value is! Map) {
      throw const FormatException('A Thinking choice is invalid.');
    }
    final json = Map<String, dynamic>.from(value);
    final id = _requiredModelText(json['id'], maximum: 40);
    final label = _requiredModelText(json['label'], maximum: 40);
    if (!_supportedReasoningLevels.contains(id) || label.isEmpty) {
      throw const FormatException('A Thinking choice is invalid.');
    }
    return TalkCommandReasoningOption(id: id, label: label);
  }
}

@immutable
class TalkCommandModelChoice {
  const TalkCommandModelChoice({
    required this.id,
    required this.assignmentId,
    required this.assignmentRevision,
    required this.assignmentConfigurationSha256,
    required this.route,
    required this.provider,
    required this.modelId,
    required this.displayName,
    required this.displayModelId,
    required this.reasoningOptions,
  });

  final String id;
  final String assignmentId;
  final int assignmentRevision;
  final String assignmentConfigurationSha256;
  final String route;
  final String provider;
  final String modelId;
  final String displayName;
  final String displayModelId;
  final List<TalkCommandReasoningOption> reasoningOptions;

  String get providerLabel => switch (provider) {
    'openai' => 'OpenAI',
    'google' => 'Google',
    'anthropic' => 'Anthropic',
    'aws_bedrock' => 'Amazon Bedrock',
    _ => provider,
  };

  String get settingsRouteLabel =>
      route == 'primary' ? 'Preferred in Settings' : 'Backup in Settings';

  factory TalkCommandModelChoice.fromJson(Object? value) {
    if (value is! Map) {
      throw const FormatException('A model choice is invalid.');
    }
    final json = Map<String, dynamic>.from(value);
    final id = _requiredModelText(json['id'], maximum: 80);
    final assignmentId = _requiredModelText(
      json['assignmentId'],
      maximum: 240,
    );
    final revision = json['assignmentRevision'];
    final configurationSha = _requiredModelText(
      json['assignmentConfigurationSha256'],
      maximum: 64,
    );
    final route = _requiredModelText(json['route'], maximum: 20);
    final provider = _requiredModelText(json['provider'], maximum: 40);
    final modelId = _requiredModelText(json['modelId'], maximum: 240);
    final displayName = _requiredModelText(
      json['displayName'],
      maximum: 160,
    );
    final displayModelId = _requiredModelText(
      json['displayModelId'],
      maximum: 240,
    );
    final rawReasoning = json['reasoningOptions'];
    if (id.isEmpty ||
        assignmentId.isEmpty ||
        revision is! int ||
        revision < 1 ||
        revision > 9007199254740991 ||
        !RegExp(r'^[a-f0-9]{64}$').hasMatch(configurationSha) ||
        !const {'primary', 'fallback'}.contains(route) ||
        !_supportedModelProviders.contains(provider) ||
        modelId.isEmpty ||
        displayName.isEmpty ||
        displayModelId.isEmpty ||
        rawReasoning is! List ||
        rawReasoning.length > 5) {
      throw const FormatException('A model choice is invalid.');
    }
    final reasoningOptions = [
      for (final option in rawReasoning)
        TalkCommandReasoningOption.fromJson(option),
    ];
    if (reasoningOptions.map((option) => option.id).toSet().length !=
        reasoningOptions.length) {
      throw const FormatException('The Thinking choices contain duplicates.');
    }
    return TalkCommandModelChoice(
      id: id,
      assignmentId: assignmentId,
      assignmentRevision: revision,
      assignmentConfigurationSha256: configurationSha,
      route: route,
      provider: provider,
      modelId: modelId,
      displayName: displayName,
      displayModelId: displayModelId,
      reasoningOptions: List.unmodifiable(reasoningOptions),
    );
  }
}

@immutable
class TalkCommandModelCatalog {
  const TalkCommandModelCatalog({
    required this.defaultChoiceId,
    required this.choices,
    required this.message,
  });

  final String? defaultChoiceId;
  final List<TalkCommandModelChoice> choices;
  final String message;

  factory TalkCommandModelCatalog.fromJson(Map<String, dynamic> payload) {
    final raw = payload['command'];
    if (raw is! Map) {
      throw const FormatException(
        'The Settings model choices are not available.',
      );
    }
    final json = Map<String, dynamic>.from(raw);
    final choicesValue = json['choices'];
    final defaultChoiceId = json['defaultChoiceId'];
    final message = _requiredModelText(json['message'], maximum: 300);
    if (json['schemaVersion'] != 1 ||
        json['scope'] != 'main_agent' ||
        choicesValue is! List ||
        choicesValue.length > 2 ||
        (defaultChoiceId != null && defaultChoiceId is! String) ||
        message.isEmpty) {
      throw const FormatException('The Settings model choices are invalid.');
    }
    final choices = [
      for (final value in choicesValue) TalkCommandModelChoice.fromJson(value),
    ];
    if (choices.map((choice) => choice.id).toSet().length != choices.length) {
      throw const FormatException('The Settings model choices contain duplicates.');
    }
    final normalizedDefault = defaultChoiceId is String
        ? _requiredModelText(defaultChoiceId, maximum: 80)
        : null;
    if (normalizedDefault != null &&
        !choices.any((choice) => choice.id == normalizedDefault)) {
      throw const FormatException('The default Settings model is invalid.');
    }
    return TalkCommandModelCatalog(
      defaultChoiceId: normalizedDefault,
      choices: List.unmodifiable(choices),
      message: message,
    );
  }
}

@immutable
class TalkCommandModelSelection {
  const TalkCommandModelSelection({
    required this.choice,
    this.reasoningLevel,
  });

  final TalkCommandModelChoice choice;
  final String? reasoningLevel;

  Map<String, dynamic> toRequestJson() {
    final reasoning = reasoningLevel;
    if (reasoning != null &&
        !choice.reasoningOptions.any((option) => option.id == reasoning)) {
      throw StateError(
        'That Thinking level is no longer available for this model.',
      );
    }
    return {
      'schemaVersion': 1,
      'assignmentId': choice.assignmentId,
      'assignmentRevision': choice.assignmentRevision,
      'assignmentConfigurationSha256': choice.assignmentConfigurationSha256,
      'route': choice.route,
      'provider': choice.provider,
      'modelId': choice.modelId,
      if (reasoning != null) 'reasoningLevel': reasoning,
    };
  }
}

String _requiredModelText(Object? value, {required int maximum}) {
  if (value is! String) return '';
  final normalized = value.trim();
  if (normalized.isEmpty || normalized.length > maximum) return '';
  if (RegExp(r'[\u0000-\u001F\u007F]').hasMatch(normalized)) return '';
  return normalized;
}
