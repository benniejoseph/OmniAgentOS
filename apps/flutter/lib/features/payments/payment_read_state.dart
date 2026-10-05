/// One independently read payment source. A missing or failed response is not
/// an empty collection; a failed refresh retains only explicitly stale data.
class PaymentReadState {
  PaymentReadState({this.collectionKey});
  final String? collectionKey;
  Map<String, dynamic>? value;
  Object? error;
  bool loading = true;

  bool get current => value != null && error == null && !loading;

  void begin() {
    loading = true;
    error = null;
  }

  void complete(Map<String, dynamic> next) {
    final key = collectionKey;
    if (key != null &&
        (next[key] is! List ||
            !(next[key] as List).every((row) => row is Map))) {
      throw const FormatException('Payment collection is unavailable.');
    }
    value = next;
    loading = false;
  }

  void fail(Object failure) {
    error = failure;
    loading = false;
  }
}
