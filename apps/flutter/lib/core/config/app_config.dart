import 'package:flutter/services.dart'
    as services
    show appBuildName, appBuildNumber;

class AppConfig {
  const AppConfig._();

  static const apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'https://asael.bennierichard.com',
  );

  /// The version this build attests. Every Flutter build embeds the
  /// pubspec.yaml version, or `--build-name` and `--build-number`, and the
  /// APP_VERSION and APP_BUILD_NUMBER defines still override it. A build with
  /// neither attests an empty version, which the server rejects.
  static const appVersion = String.fromEnvironment(
    'APP_VERSION',
    defaultValue: services.appBuildName ?? '',
  );
  static final appBuildNumber =
      int.tryParse(
        const String.fromEnvironment(
          'APP_BUILD_NUMBER',
          defaultValue: services.appBuildNumber ?? '',
        ),
      ) ??
      0;
}
