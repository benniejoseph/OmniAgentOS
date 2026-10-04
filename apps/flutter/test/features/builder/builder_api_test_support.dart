import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/builder/builder_contracts.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'builder_test_support.dart';

class BuilderTestApi extends ApiClient {
  BuilderTestApi({String origin = builderApi})
    : super(
        Dio(BaseOptions(baseUrl: origin)),
        Dio(),
        SecureSessionStore(const FlutterSecureStorage()),
      );
  Future<BuilderJson> Function(String, BuilderJson?, CancelToken)? read;
  Future<BuilderJson> Function(BuilderJson)? write;
  final List<({String path, BuilderJson? query})> reads = [];
  final List<CancelToken> tokens = [];
  NativeRequestAuthority? authority;
  BuilderJson? posted, headers;
  String? postPath;
  @override
  Future<BuilderJson> getJsonFreshCancelable(
    String path, {
    BuilderJson? query,
    BuilderJson? headers,
    required CancelToken cancelToken,
  }) async {
    reads.add((path: path, query: query));
    tokens.add(cancelToken);
    return read != null ? read!(path, query, cancelToken) : snapshotJson();
  }

  @override
  Future<BuilderJson> postJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    BuilderJson? data,
    BuilderJson? headers,
  }) async {
    this.authority = authority;
    posted = data;
    this.headers = headers;
    postPath = path;
    final response = write != null ? await write!(data!) : responseJson(data!);
    return sealTestBuilderReceipt(
      response,
      authority.tenantId,
      headers!['idempotency-key'] as String,
    );
  }

  @override
  Future<BuilderJson> postJson(
    String path, {
    BuilderJson? data,
    BuilderJson? headers,
  }) => throw StateError('Unbound mutation must never be called.');
}

Future<BuilderJson> sealTestBuilderReceipt(
  BuilderJson response,
  String tenant,
  String key,
) async {
  Future<String> hash(String value) async =>
      (await Sha256().hash(utf8.encode(value))).bytes
          .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
          .join();
  final receipt = builderMap(response['serviceReceipt'])
    ..remove('receiptSha256');
  receipt['idempotencyKeySha256'] = await hash('$tenant\u0000$key');
  final fields = receipt.keys.toList()..sort();
  receipt['receiptSha256'] = await hash(
    jsonEncode({for (final field in fields) field: receipt[field]}),
  );
  return {...response, 'serviceReceipt': receipt};
}
