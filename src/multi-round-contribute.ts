/**
 * Mirror of macp-runtime's `parse_contribute_value` (`multi_round.rs`) at
 * `semantics_rev` 3, so a projection stores the value the runtime stored.
 * Internal: `MultiRoundProjection` reads `Contribute` with it, and so does
 * `ProtoRegistry.decodeKnownPayload` for any bytes the runtime accepts.
 * Parity with macp-sdk-python.
 *
 * The runtime reads the bytes two ways:
 * - legacy JSON: `serde_json::from_str::<ContributeJson { value: String }>`
 *   over the payload as UTF-8;
 * - canonical protobuf: prost's `ContributePayload::decode`.
 *
 * JSON wins unless the bytes are also the exact canonical proto encoding
 * (the issue #192 tie-break). Anything neither reading accepts has no value.
 *
 * Both readers are reproduced exactly, because a lenient one would diverge on
 * hostile input. serde_json 1.0.154 and prost 0.14.4 behave like this:
 * - serde refuses a duplicate `value` member, but accepts duplicates of any
 *   other key;
 * - serde refuses a lone surrogate escape in a top-level key or in `value`,
 *   but not anywhere inside an ignored member's value (keys included);
 * - a derived struct also deserializes from a one-element array (`["v"]`);
 * - prost refuses a `string` field that isn't UTF-8, and a field 1 with the
 *   wrong wire type.
 */

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The value the runtime stores for a Contribute payload, or `undefined` when it would refuse it. */
export function parseContributeValue(payload: Uint8Array): string | undefined {
  if (payload.length === 0) return undefined;
  const proto = decodeProto(payload);
  let text: string | undefined;
  try {
    text = STRICT_UTF8.decode(payload);
  } catch {
    text = undefined;
  }
  if (text !== undefined) {
    const json = legacyJsonValue(text);
    if (json !== undefined && !(proto !== undefined && isCanonical(proto, payload))) return json;
  }
  return proto;
}

// ── prost: ContributePayload { string value = 1; } ───────────────────

const RECURSION_LIMIT = 100;

class Reject extends Error {}

/** prost's decode: the last field-1 value (each occurrence must be UTF-8), '' when absent, `undefined` on error. */
function decodeProto(bytes: Uint8Array): string | undefined {
  const reader = { bytes, pos: 0 };
  let value = '';
  try {
    while (reader.pos < bytes.length) {
      const [field, wireType] = readKey(reader);
      if (field === 1) {
        if (wireType !== 2) throw new Reject();
        value = STRICT_UTF8.decode(readLengthDelimited(reader));
      } else {
        skipField(reader, wireType, field, 0);
      }
    }
  } catch {
    return undefined;
  }
  return value;
}

/** The canonical encoding of `ContributePayload { value }` equals `bytes`. */
function isCanonical(value: string, bytes: Uint8Array): boolean {
  const utf8 = new TextEncoder().encode(value);
  if (utf8.length === 0) return bytes.length === 0;
  const header = [0x0a];
  for (let n = utf8.length; ; n = Math.floor(n / 128)) {
    if (n < 128) {
      header.push(n);
      break;
    }
    header.push((n % 128) | 0x80);
  }
  if (bytes.length !== header.length + utf8.length) return false;
  return header.every((b, i) => bytes[i] === b) && utf8.every((b, i) => bytes[header.length + i] === b);
}

interface Reader {
  bytes: Uint8Array;
  pos: number;
}

/** prost's `decode_varint`: at most 10 bytes, the 10th at most 1. As a JS number, exact up to 2^53. */
function readVarint(reader: Reader): number {
  let result = 0;
  for (let i = 0; i < 10; i++) {
    if (reader.pos >= reader.bytes.length) throw new Reject();
    const byte = reader.bytes[reader.pos++]!;
    if (i === 9 && byte > 1) throw new Reject();
    result += (byte & 0x7f) * 2 ** (7 * i);
    if (byte < 0x80) return result;
  }
  throw new Reject();
}

/** prost's `decode_key`: a key above u32, a wire type above 5, or tag 0 is an error. */
function readKey(reader: Reader): [number, number] {
  const key = readVarint(reader);
  if (key > 0xffffffff) throw new Reject();
  const wireType = key % 8;
  const field = Math.floor(key / 8);
  if (wireType > 5 || field === 0) throw new Reject();
  return [field, wireType];
}

function readLengthDelimited(reader: Reader): Uint8Array {
  const length = readVarint(reader);
  if (length > reader.bytes.length - reader.pos) throw new Reject();
  const out = reader.bytes.subarray(reader.pos, reader.pos + length);
  reader.pos += length;
  return out;
}

/** prost's `skip_field`, including its recursion limit and matched end-group check. */
function skipField(reader: Reader, wireType: number, field: number, depth: number): void {
  if (depth >= RECURSION_LIMIT) throw new Reject();
  let length: number;
  switch (wireType) {
    case 0:
      readVarint(reader);
      return;
    case 1:
      length = 8;
      break;
    case 2:
      readLengthDelimited(reader);
      return;
    case 3:
      for (;;) {
        const [innerField, innerWireType] = readKey(reader);
        if (innerWireType === 4) {
          if (innerField !== field) throw new Reject();
          return;
        }
        skipField(reader, innerWireType, innerField, depth + 1);
      }
    case 5:
      length = 4;
      break;
    default:
      throw new Reject(); // an end group with no start
  }
  if (length > reader.bytes.length - reader.pos) throw new Reject();
  reader.pos += length;
}

// ── serde_json: ContributeJson { value: String } ─────────────────────

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/** serde's `from_str::<ContributeJson>`: the `value`, or `undefined` when serde would refuse the text. */
function legacyJsonValue(text: string): string | undefined {
  const s = { text, pos: 0 };
  try {
    skipWhitespace(s);
    let value: string | undefined;
    if (text[s.pos] === '{') {
      s.pos++;
      skipWhitespace(s);
      if (text[s.pos] === '}') throw new Reject(); // missing field `value`
      for (;;) {
        const key = readString(s, true);
        skipWhitespace(s);
        expect(s, ':');
        skipWhitespace(s);
        if (key === 'value') {
          if (value !== undefined) throw new Reject(); // duplicate field `value`
          value = readString(s, true);
        } else {
          skipValue(s);
        }
        skipWhitespace(s);
        if (text[s.pos] === ',') {
          s.pos++;
          skipWhitespace(s);
          continue;
        }
        expect(s, '}');
        break;
      }
      if (value === undefined) throw new Reject();
    } else if (text[s.pos] === '[') {
      s.pos++;
      skipWhitespace(s);
      value = readString(s, true);
      skipWhitespace(s);
      expect(s, ']');
    } else {
      throw new Reject();
    }
    skipWhitespace(s);
    if (s.pos !== text.length) throw new Reject(); // trailing characters
    return value;
  } catch (error) {
    if (error instanceof Reject) return undefined;
    throw error;
  }
}

interface Scanner {
  text: string;
  pos: number;
}

function skipWhitespace(s: Scanner): void {
  while (s.pos < s.text.length && ' \t\n\r'.includes(s.text[s.pos]!)) s.pos++;
}

function expect(s: Scanner, ch: string): void {
  if (s.text[s.pos] !== ch) throw new Reject();
  s.pos++;
}

/**
 * A JSON string at `s.pos`. `validate`: serde's real string parse, which
 * refuses a lone surrogate escape. Otherwise serde's ignore path, which only
 * consumes the escape's four hex digits.
 */
function readString(s: Scanner, validate: boolean): string {
  expect(s, '"');
  const start = s.pos;
  for (;;) {
    if (s.pos >= s.text.length) throw new Reject();
    const ch = s.text.charCodeAt(s.pos);
    if (ch === 0x22) break;
    if (ch < 0x20) throw new Reject();
    if (ch === 0x5c) {
      const escape = s.text[s.pos + 1];
      if (escape === 'u') {
        if (!/^[0-9a-fA-F]{4}$/.test(s.text.slice(s.pos + 2, s.pos + 6))) throw new Reject();
        s.pos += 6;
        continue;
      }
      if (escape === undefined || !'"\\/bfnrt'.includes(escape)) throw new Reject();
      s.pos += 2;
      continue;
    }
    s.pos++;
  }
  const raw = s.text.slice(start, s.pos);
  s.pos++;
  if (!validate) return '';
  // The raw text is valid JSON string content, so JSON.parse only unescapes it.
  const decoded = JSON.parse(`"${raw}"`) as string;
  if (LONE_SURROGATE.test(decoded)) throw new Reject();
  return decoded;
}

/** Skip any JSON value the way serde's IgnoredAny does, iteratively (no depth limit applies). */
function skipValue(s: Scanner): void {
  // Each entry is the closing character of an open container, and whether a value may come next.
  const stack: string[] = [];
  for (;;) {
    skipWhitespace(s);
    const ch = s.text[s.pos];
    if (ch === '{' || ch === '[') {
      s.pos++;
      skipWhitespace(s);
      const close = ch === '{' ? '}' : ']';
      if (s.text[s.pos] === close) {
        s.pos++;
      } else {
        stack.push(close);
        if (close === '}') readMemberKey(s);
        continue;
      }
    } else if (ch === '"') {
      readString(s, false);
    } else if (ch === 't' || ch === 'f' || ch === 'n') {
      const literal = ch === 't' ? 'true' : ch === 'f' ? 'false' : 'null';
      if (!s.text.startsWith(literal, s.pos)) throw new Reject();
      s.pos += literal.length;
    } else {
      NUMBER.lastIndex = s.pos;
      if (!NUMBER.test(s.text)) throw new Reject();
      s.pos = NUMBER.lastIndex;
    }
    // A value is complete: close containers or move to the next element.
    for (;;) {
      if (stack.length === 0) return;
      skipWhitespace(s);
      const close = stack[stack.length - 1]!;
      if (s.text[s.pos] === ',') {
        s.pos++;
        skipWhitespace(s);
        if (close === '}') readMemberKey(s);
        break;
      }
      expect(s, close);
      stack.pop();
    }
  }
}

/** An object member's key and colon inside an ignored value. serde doesn't validate keys there. */
function readMemberKey(s: Scanner): void {
  readString(s, false);
  skipWhitespace(s);
  expect(s, ':');
}
