import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/dart.dart';

/// Matches sources/contracts.ts: sorted UTF-16 keys, original array order and
/// ECMAScript JSON primitive spelling. This is not a normalization of content.
String portableCanonicalJson(Object? value) {
  final output = StringBuffer();
  _writeCanonical(value, output, 0);
  return output.toString();
}

String portableCanonicalSha256(Object? value) =>
    portableTextSha256(portableCanonicalJson(value));

/// Both Node Buffer.from(text, 'utf8') and Dart's UTF-8 encoder replace an
/// unpaired UTF-16 surrogate with U+FFFD. Canonical JSON itself escapes it.
String portableTextSha256(String value) =>
    portableBytesSha256(utf8.encode(value));

String portableBytesSha256(List<int> value) => const DartSha256()
    .hashSync(value)
    .bytes
    .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
    .join();

void _writeCanonical(Object? value, StringBuffer output, int depth) {
  if (depth > 32) {
    throw const FormatException('Archive JSON exceeds the nesting limit.');
  }
  if (value == null) {
    output.write('null');
  } else if (value is String) {
    _writeString(value, output);
  } else if (value is bool) {
    output.write(value ? 'true' : 'false');
  } else if (value is num) {
    output.write(portableJavaScriptNumber(value));
  } else if (value is List) {
    output.write('[');
    for (var i = 0; i < value.length; i++) {
      if (i != 0) output.write(',');
      _writeCanonical(value[i], output, depth + 1);
    }
    output.write(']');
  } else if (value is Map<String, dynamic>) {
    final keys = value.keys.toList()..sort(_compareUtf16);
    output.write('{');
    for (var i = 0; i < keys.length; i++) {
      if (i != 0) output.write(',');
      _writeString(keys[i], output);
      output.write(':');
      _writeCanonical(value[keys[i]], output, depth + 1);
    }
    output.write('}');
  } else {
    throw const FormatException('Archive contains a non-JSON value.');
  }
}

int _compareUtf16(String left, String right) {
  final limit = left.length < right.length ? left.length : right.length;
  for (var i = 0; i < limit; i++) {
    final difference = left.codeUnitAt(i) - right.codeUnitAt(i);
    if (difference != 0) return difference;
  }
  return left.length - right.length;
}

void _writeString(String value, StringBuffer output) {
  output.write('"');
  for (var i = 0; i < value.length; i++) {
    final unit = value.codeUnitAt(i);
    switch (unit) {
      case 0x22:
        output.write(r'\"');
      case 0x5c:
        output.write(r'\\');
      case 0x08:
        output.write(r'\b');
      case 0x0c:
        output.write(r'\f');
      case 0x0a:
        output.write(r'\n');
      case 0x0d:
        output.write(r'\r');
      case 0x09:
        output.write(r'\t');
      default:
        if (unit < 0x20 ||
            (unit >= 0xdc00 && unit <= 0xdfff) ||
            (unit >= 0xd800 &&
                unit <= 0xdbff &&
                (i + 1 == value.length ||
                    value.codeUnitAt(i + 1) < 0xdc00 ||
                    value.codeUnitAt(i + 1) > 0xdfff))) {
          output.write('\\u${unit.toRadixString(16).padLeft(4, '0')}');
        } else if (unit >= 0xd800 && unit <= 0xdbff) {
          output.write(value.substring(i, i + 2));
          i++;
        } else {
          output.writeCharCode(unit);
        }
    }
  }
  output.write('"');
}

final _binaryScale = BigInt.one << 1075;
final _powersOfTen = <int, BigInt>{0: BigInt.one};
BigInt _ten(int exponent) =>
    _powersOfTen.putIfAbsent(exponent, () => BigInt.from(10).pow(exponent));

/// Implements the shortest decimal representation of a binary64 value, using
/// exact rounding intervals. Dart's toString spelling is deliberately not used:
/// its decimal/exponent thresholds and its large-integer spelling can differ
/// from JSON.stringify. Midpoint endpoints belong to the even significand.
String portableJavaScriptNumber(num input) {
  final number = input.toDouble();
  if (!number.isFinite) {
    throw const FormatException('Archive numbers must be finite.');
  }
  if (number == 0) return '0';
  final negative = number < 0;
  final magnitude = number.abs();
  if (magnitude <= 9007199254740991 &&
      magnitude == magnitude.truncateToDouble()) {
    return '${negative ? '-' : ''}${magnitude.toInt()}';
  }
  final bits = ByteData(8)..setFloat64(0, magnitude, Endian.big);
  final high = bits.getUint32(0, Endian.big);
  final low = bits.getUint32(4, Endian.big);
  final exponentBits = (high >> 20) & 0x7ff;
  final fraction = (BigInt.from(high & 0xfffff) << 32) | BigInt.from(low);
  final significand = exponentBits == 0
      ? fraction
      : (BigInt.one << 52) | fraction;
  final power = exponentBits == 0 ? -1074 : exponentBits - 1075;
  final scaled = significand << (power + 1075);
  final upperStep = BigInt.one << (power + 1074);
  final lowerStep = exponentBits > 1 && fraction == BigInt.zero
      ? upperStep >> 1
      : upperStep;
  final lower = scaled - lowerStep;
  final upper = scaled + upperStep;
  final inclusive = significand.isEven;

  // Exact floor(log10(magnitude)), including subnormal values and powers whose
  // closest binary64 representation lies just below the decimal power.
  var lo = -325;
  var hi = 309;
  while (hi - lo > 1) {
    final middle = (lo + hi) >> 1;
    final comparison = middle >= 0
        ? scaled.compareTo(_binaryScale * _ten(middle))
        : (scaled * _ten(-middle)).compareTo(_binaryScale);
    if (comparison >= 0) {
      lo = middle;
    } else {
      hi = middle;
    }
  }

  for (var digits = 1; digits <= 17; digits++) {
    _DecimalCandidate? best;
    for (final exponent in [lo - digits + 1, lo - digits + 2]) {
      final multiplier = exponent < 0 ? _ten(-exponent) : BigInt.one;
      final divisor = exponent >= 0
          ? _binaryScale * _ten(exponent)
          : _binaryScale;
      final lowNumerator = lower * multiplier;
      final highNumerator = upper * multiplier;
      var minimum = lowNumerator ~/ divisor;
      if (lowNumerator.remainder(divisor) != BigInt.zero || !inclusive) {
        minimum += BigInt.one;
      }
      var maximum = highNumerator ~/ divisor;
      if (!inclusive && highNumerator.remainder(divisor) == BigInt.zero) {
        maximum -= BigInt.one;
      }
      final digitMinimum = _ten(digits - 1);
      final digitMaximum = _ten(digits) - BigInt.one;
      if (minimum < digitMinimum) minimum = digitMinimum;
      if (maximum > digitMaximum) maximum = digitMaximum;
      if (minimum > maximum) continue;

      final numerator = scaled * multiplier;
      var nearest = numerator ~/ divisor;
      final remainderTwice = numerator.remainder(divisor) << 1;
      if (remainderTwice > divisor ||
          (remainderTwice == divisor && nearest.isOdd)) {
        nearest += BigInt.one;
      }
      if (nearest < minimum) nearest = minimum;
      if (nearest > maximum) nearest = maximum;
      final candidate = _DecimalCandidate(
        nearest,
        exponent,
        (nearest * divisor - numerator).abs(),
        multiplier,
      );
      if (best == null || candidate.isCloserThan(best)) best = candidate;
    }
    if (best != null) {
      final digitsText = best.significand.toString();
      final point = digitsText.length + best.exponent;
      final String body;
      if (point > 0 && point <= 21) {
        body = point >= digitsText.length
            ? '$digitsText${'0' * (point - digitsText.length)}'
            : '${digitsText.substring(0, point)}.${digitsText.substring(point)}';
      } else if (point <= 0 && point > -6) {
        body = '0.${'0' * -point}$digitsText';
      } else {
        final exponent = point - 1;
        body =
            '${digitsText[0]}'
            '${digitsText.length > 1 ? '.${digitsText.substring(1)}' : ''}'
            'e${exponent >= 0 ? '+' : ''}$exponent';
      }
      return '${negative ? '-' : ''}$body';
    }
  }
  throw const FormatException('Archive number could not be canonicalized.');
}

class _DecimalCandidate {
  const _DecimalCandidate(
    this.significand,
    this.exponent,
    this.distance,
    this.denominator,
  );
  final BigInt significand;
  final int exponent;
  final BigInt distance;
  final BigInt denominator;

  bool isCloserThan(_DecimalCandidate other) {
    final comparison = (distance * other.denominator).compareTo(
      other.distance * denominator,
    );
    return comparison < 0 ||
        (comparison == 0 && significand.isEven && other.significand.isOdd);
  }
}

/// Parses JSON before recursive validation/hashing, with bounds checked while
/// parsing. Every JSON number is binary64 as in JSON.parse; native Dart integer
/// parsing would otherwise retain values the server has already rounded.
Object? decodePortableJson(String source) => _BoundedJsonParser(source).parse();

class _BoundedJsonParser {
  _BoundedJsonParser(this.source);
  final String source;
  var index = 0;
  var nodes = 0;

  Object? parse() {
    final value = _value(0);
    _space();
    if (index != source.length) _invalid();
    return value;
  }

  Never _invalid() => throw const FormatException(
    'Archive JSON is invalid or exceeds native limits.',
  );

  void _space() {
    while (index < source.length) {
      final unit = source.codeUnitAt(index);
      if (unit != 0x20 && unit != 0x09 && unit != 0x0a && unit != 0x0d) break;
      index++;
    }
  }

  Object? _value(int depth) {
    if (depth > 32 || ++nodes > 1000000) _invalid();
    _space();
    if (index >= source.length) _invalid();
    final unit = source.codeUnitAt(index);
    if (unit == 0x22) return _string();
    if (unit == 0x7b) {
      index++;
      _space();
      final value = <String, Object?>{};
      if (_take(0x7d)) return value;
      while (true) {
        _space();
        if (index >= source.length ||
            source.codeUnitAt(index) != 0x22 ||
            ++nodes > 1000000) {
          _invalid();
        }
        final key = _string();
        if (value.containsKey(key)) _invalid();
        _space();
        if (!_take(0x3a)) _invalid();
        value[key] = _value(depth + 1);
        _space();
        if (_take(0x7d)) return value;
        if (!_take(0x2c)) _invalid();
      }
    }
    if (unit == 0x5b) {
      index++;
      _space();
      final value = <Object?>[];
      if (_take(0x5d)) return value;
      while (true) {
        value.add(_value(depth + 1));
        _space();
        if (_take(0x5d)) return value;
        if (!_take(0x2c)) _invalid();
      }
    }
    for (final literal in const {
      'null': null,
      'true': true,
      'false': false,
    }.entries) {
      if (source.startsWith(literal.key, index)) {
        index += literal.key.length;
        return literal.value;
      }
    }
    return _number();
  }

  bool _take(int unit) {
    if (index < source.length && source.codeUnitAt(index) == unit) {
      index++;
      return true;
    }
    return false;
  }

  bool get _digit =>
      index < source.length &&
      source.codeUnitAt(index) >= 0x30 &&
      source.codeUnitAt(index) <= 0x39;

  double _number() {
    final start = index;
    _take(0x2d);
    if (!_take(0x30)) {
      if (!_digit) _invalid();
      while (_digit) {
        index++;
      }
    }
    if (_take(0x2e)) {
      if (!_digit) _invalid();
      while (_digit) {
        index++;
      }
    }
    if (_take(0x65) || _take(0x45)) {
      if (!_take(0x2b)) _take(0x2d);
      if (!_digit) _invalid();
      while (_digit) {
        index++;
      }
    }
    if (index - start > 128) _invalid();
    final number = double.tryParse(source.substring(start, index));
    if (number == null || !number.isFinite) _invalid();
    return number;
  }

  String _string() {
    index++;
    var start = index;
    StringBuffer? output;
    while (index < source.length) {
      final unit = source.codeUnitAt(index++);
      if (unit == 0x22) {
        final tail = source.substring(start, index - 1);
        if (output == null) return tail;
        output.write(tail);
        return output.toString();
      }
      if (unit < 0x20) _invalid();
      if (unit != 0x5c) continue;
      output ??= StringBuffer();
      output.write(source.substring(start, index - 1));
      if (index >= source.length) _invalid();
      final escape = source.codeUnitAt(index++);
      final int decoded;
      switch (escape) {
        case 0x22 || 0x5c || 0x2f:
          decoded = escape;
        case 0x62:
          decoded = 0x08;
        case 0x66:
          decoded = 0x0c;
        case 0x6e:
          decoded = 0x0a;
        case 0x72:
          decoded = 0x0d;
        case 0x74:
          decoded = 0x09;
        case 0x75:
          if (index + 4 > source.length) _invalid();
          final hex = source.substring(index, index + 4);
          if (!RegExp(r'^[0-9a-fA-F]{4}$').hasMatch(hex)) _invalid();
          decoded = int.parse(hex, radix: 16);
          index += 4;
        default:
          _invalid();
      }
      output.writeCharCode(decoded);
      start = index;
    }
    _invalid();
  }
}
