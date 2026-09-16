class AppConfig {
  const AppConfig._();

  static const apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'https://asael.bennierichard.com',
  );

  static const appVersion = String.fromEnvironment(
    'APP_VERSION',
    defaultValue: '1.3.0',
  );
  static const appBuildNumber = int.fromEnvironment(
    'APP_BUILD_NUMBER',
    defaultValue: 4,
  );
}
