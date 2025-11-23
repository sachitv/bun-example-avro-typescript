// node_modules/@sachitv/avro-typescript/src/serialization/buffers/blob_readable_buffer.js
class BlobReadableBuffer {
  #blob;
  constructor(blob) {
    this.#blob = blob;
  }
  async length() {
    return this.#blob.size;
  }
  async read(offset, size) {
    if (offset + size > this.#blob.size)
      return;
    const sliced = this.#blob.slice(offset, offset + size);
    const arrayBuffer = await sliced.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }
  async canReadMore(offset) {
    const result = await this.read(offset, 1);
    return result !== undefined;
  }
}

// node_modules/@sachitv/avro-typescript/src/serialization/streams/stream_readable_buffer.js
class StreamReadableBuffer {
  #reader;
  constructor(stream) {
    this.#reader = stream.getReader();
  }
  async readNext() {
    const { done, value } = await this.#reader.read();
    if (done) {
      return;
    }
    return value;
  }
  async close() {
    this.#reader.releaseLock();
  }
}

// node_modules/@sachitv/avro-typescript/src/internal/collections/circular_buffer.js
class CircularBuffer {
  #buffer;
  #capacity;
  #windowStart;
  #windowEnd;
  constructor(capacity) {
    if (capacity <= 0) {
      throw new RangeError("Capacity must be positive");
    }
    this.#capacity = capacity;
    this.#buffer = new Uint8Array(capacity);
    this.#windowStart = 0;
    this.#windowEnd = 0;
  }
  capacity() {
    return this.#capacity;
  }
  length() {
    return this.#windowEnd - this.#windowStart;
  }
  windowStart() {
    return this.#windowStart;
  }
  windowEnd() {
    return this.#windowEnd;
  }
  clear() {
    this.#windowStart = 0;
    this.#windowEnd = 0;
  }
  push(data) {
    if (data.length === 0) {
      return;
    }
    this.#validateDataSize(data.length);
    this.#slideWindowIfNeeded(data.length);
    this.#addData(data);
  }
  #validateDataSize(dataSize) {
    if (dataSize > this.#capacity) {
      throw new RangeError(`Data size ${dataSize} exceeds buffer capacity ${this.#capacity}`);
    }
  }
  #slideWindowIfNeeded(dataSize) {
    const currentLength = this.length();
    if (currentLength + dataSize > this.#capacity) {
      const slideAmount = currentLength + dataSize - this.#capacity;
      const newWindowStart = this.#windowStart + slideAmount;
      const shift = newWindowStart - this.#windowStart;
      if (shift > 0 && shift <= currentLength) {
        this.#buffer.copyWithin(0, shift, currentLength);
        this.#windowStart = newWindowStart;
        this.#windowEnd = this.#windowStart + (currentLength - shift);
      }
    }
  }
  #addData(data) {
    const bufferOffset = this.#windowEnd - this.#windowStart;
    this.#buffer.set(data, bufferOffset);
    this.#windowEnd += data.length;
  }
  get(start, size) {
    this.#validateGetParameters(start, size);
    this.#validateGetRange(start, size);
    const bufferStart = start - this.#windowStart;
    return this.#buffer.subarray(bufferStart, bufferStart + size);
  }
  #validateGetParameters(start, size) {
    if (start < this.#windowStart) {
      throw new RangeError(`Start position ${start} is before window start ${this.#windowStart}`);
    }
    if (size < 0) {
      throw new RangeError(`Size ${size} cannot be negative`);
    }
  }
  #validateGetRange(start, size) {
    const end = start + size;
    if (end > this.#windowEnd) {
      throw new RangeError(`Requested range [${start}, ${end}) extends beyond window end ${this.#windowEnd}`);
    }
  }
}

// node_modules/@sachitv/avro-typescript/src/serialization/streams/fixed_size_stream_readable_buffer_adapter.js
class FixedSizeStreamReadableBufferAdapter {
  #streamBuffer;
  #windowSize;
  #circularBuffer;
  #eof;
  constructor(streamBuffer, windowSize, circularBuffer) {
    if (windowSize <= 0) {
      throw new RangeError("Window size must be positive");
    }
    this.#streamBuffer = streamBuffer;
    this.#windowSize = windowSize;
    this.#circularBuffer = circularBuffer ?? new CircularBuffer(windowSize);
    this.#eof = false;
  }
  async length() {
    return this.#circularBuffer.windowEnd();
  }
  async read(offset, size) {
    if (offset < 0 || size < 0) {
      return;
    }
    if (size > this.#windowSize) {
      throw new RangeError(`Requested size ${size} exceeds window size ${this.#windowSize}`);
    }
    if (offset < this.#circularBuffer.windowStart()) {
      throw new RangeError(`Cannot read data before window start. Offset ${offset} is before window start ${this.#circularBuffer.windowStart()}`);
    }
    if (offset + size <= this.#circularBuffer.windowEnd()) {
      return this.#extractFromBuffer(offset, size);
    }
    await this.#fillBuffer(offset + size);
    if (offset + size > this.#circularBuffer.windowEnd()) {
      return;
    }
    return this.#extractFromBuffer(offset, size);
  }
  async canReadMore(offset) {
    const result = await this.read(offset, 1);
    return result !== undefined;
  }
  #extractFromBuffer(offset, size) {
    return this.#circularBuffer.get(offset, size);
  }
  async#fillBuffer(targetOffset) {
    while (!this.#eof && this.#circularBuffer.windowEnd() < targetOffset) {
      const chunk = await this.#streamBuffer.readNext();
      if (chunk === undefined) {
        this.#eof = true;
        break;
      }
      try {
        this.#circularBuffer.push(chunk);
      } catch (error) {
        if (error instanceof RangeError) {
          throw new RangeError(`Cannot buffer chunk of size ${chunk.length}: ${error.message}`);
        }
        throw error;
      }
    }
  }
}

// node_modules/@sachitv/avro-typescript/src/serialization/streams/forward_only_stream_readable_buffer_adapter.js
class ForwardOnlyStreamReadableBufferAdapter {
  #bufferedData = null;
  #streamBuffer;
  #eof = false;
  #currentPosition = 0;
  constructor(streamBuffer) {
    this.#streamBuffer = streamBuffer;
  }
  async read(offset, size) {
    if (offset < 0 || size < 0) {
      return;
    }
    if (offset < this.#currentPosition) {
      throw new Error("Cannot read backwards from current position");
    }
    if (offset > this.#currentPosition) {
      throw new Error("Cannot seek forward; reads must be sequential");
    }
    await this.#ensureBufferedUpTo(this.#currentPosition + size);
    if (this.#bufferedData === null || size > this.#bufferedData.length) {
      return;
    }
    const result = this.#bufferedData.slice(0, size);
    this.#currentPosition += size;
    this.#bufferedData = this.#bufferedData.slice(size);
    return result;
  }
  async canReadMore(offset) {
    if (offset < this.#currentPosition) {
      throw new Error("Cannot read backwards from current position");
    }
    if (offset > this.#currentPosition) {
      throw new Error("Cannot seek forward; reads must be sequential");
    }
    await this.#ensureBufferedUpTo(this.#currentPosition + 1);
    if (this.#bufferedData === null) {
      return false;
    }
    return this.#bufferedData.length > 0;
  }
  async#ensureBufferedUpTo(targetOffset) {
    while (!this.#eof && (this.#bufferedData === null || this.#bufferedData.length + this.#currentPosition < targetOffset)) {
      const chunk = await this.#streamBuffer.readNext();
      if (chunk === undefined) {
        this.#eof = true;
        break;
      }
      if (this.#bufferedData === null) {
        this.#bufferedData = chunk;
      } else {
        const currentLength = this.#bufferedData.length;
        const newBuffer = new Uint8Array(currentLength + chunk.length);
        newBuffer.set(this.#bufferedData);
        newBuffer.set(chunk, currentLength);
        this.#bufferedData = newBuffer;
      }
    }
  }
}

// node_modules/@sachitv/avro-typescript/src/serialization/conversion.js
var MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
var MIN_SAFE_INTEGER_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
function bigIntToSafeNumber(value, context) {
  if (value > MAX_SAFE_INTEGER_BIGINT || value < MIN_SAFE_INTEGER_BIGINT) {
    throw new RangeError(`${context} is outside the safe integer range.`);
  }
  return Number(value);
}

// node_modules/@sachitv/avro-typescript/src/serialization/clamp.js
function clampLengthForView(view, offset, length) {
  if (offset >= view.byteLength) {
    return 0;
  }
  const available = view.byteLength - offset;
  if (length <= 0) {
    return 0;
  }
  return length > available ? available : length;
}

// node_modules/@sachitv/avro-typescript/src/serialization/compare_bytes.js
function _compareByteRanges(viewA, offsetA, lengthA, viewB, offsetB, lengthB) {
  const safeOffsetA = offsetA >= 0 ? offsetA : 0;
  const safeOffsetB = offsetB >= 0 ? offsetB : 0;
  const clampedLengthA = clampLengthForView(viewA, safeOffsetA, lengthA);
  const clampedLengthB = clampLengthForView(viewB, safeOffsetB, lengthB);
  const len = Math.min(clampedLengthA, clampedLengthB);
  for (let i = 0;i < len; i++) {
    const diff = viewA.getUint8(safeOffsetA + i) - viewB.getUint8(safeOffsetB + i);
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }
  if (clampedLengthA === clampedLengthB) {
    return 0;
  }
  return clampedLengthA < clampedLengthB ? -1 : 1;
}
function compareUint8Arrays(a, b) {
  const viewA = new DataView(a.buffer, a.byteOffset, a.byteLength);
  const viewB = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return _compareByteRanges(viewA, 0, a.length, viewB, 0, b.length);
}

// node_modules/@sachitv/avro-typescript/src/serialization/read_uint_le.js
function readUIntLE(view, offset, byteLength) {
  let value = 0;
  for (let i = 0;i < byteLength; i++) {
    const index = offset + i;
    if (index >= view.byteLength) {
      break;
    }
    value |= view.getUint8(index) << 8 * i;
  }
  return value >>> 0;
}

// node_modules/@sachitv/avro-typescript/src/serialization/manipulate_bytes.js
function invert(arr, len) {
  const view = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
  let remaining = Math.min(Math.max(len, 0), arr.length);
  while (remaining--) {
    const current = view.getUint8(remaining);
    view.setUint8(remaining, ~current & 255);
  }
}

// node_modules/@sachitv/avro-typescript/src/serialization/text_encoding.js
var encoder = new TextEncoder;
var decoder = new TextDecoder;
var encode = (input) => encoder.encode(input);
var decode = (bytes) => decoder.decode(bytes);

// node_modules/@sachitv/avro-typescript/src/serialization/buffers/in_memory_buffer.js
class InMemoryBufferBase {
  view;
  constructor(buf) {
    this.view = new Uint8Array(buf);
  }
  async length() {
    return this.view.length;
  }
}

class InMemoryReadableBuffer extends InMemoryBufferBase {
  checkBounds(offset, size) {
    if (offset < 0 || size < 0) {
      throw new RangeError(`Offset and size must be non-negative. Got offset=${offset}, size=${size}`);
    }
    if (offset + size > this.view.length) {
      throw new RangeError(`Operation exceeds buffer bounds. offset=${offset}, size=${size}, bufferLength=${this.view.length}`);
    }
  }
  async read(offset, size) {
    this.checkBounds(offset, size);
    return this.view.slice(offset, offset + size);
  }
  async canReadMore(offset) {
    try {
      this.checkBounds(offset, 1);
      return true;
    } catch {
      return false;
    }
  }
}

class InMemoryWritableBuffer extends InMemoryBufferBase {
  #offset;
  constructor(buf, offset = 0) {
    super(buf);
    if (offset < 0 || offset > this.view.length) {
      throw new RangeError(`Initial offset must be within buffer bounds. Got offset=${offset}, bufferLength=${this.view.length}`);
    }
    this.#offset = offset;
  }
  checkWriteBounds(offset, data) {
    if (offset < 0) {
      throw new RangeError(`Offset must be non-negative. Got offset=${offset}`);
    }
    if (offset + data.length > this.view.length) {
      throw new RangeError(`Write operation exceeds buffer bounds. offset=${offset}, dataSize=${data.length}, bufferLength=${this.view.length}`);
    }
  }
  async appendBytes(data) {
    this.checkWriteBounds(this.#offset, data);
    if (data.length === 0) {
      return;
    }
    this.view.set(data, this.#offset);
    this.#offset += data.length;
  }
  async isValid() {
    return true;
  }
  async canAppendMore(_size) {
    return await this.isValid();
  }
  _testOnlyOffset() {
    return this.#offset;
  }
  _testOnlyRemaining() {
    return this.view.length - this.#offset;
  }
}

// node_modules/@sachitv/avro-typescript/src/serialization/tap.js
function assertValidPosition(pos) {
  if (!Number.isFinite(pos) || !Number.isInteger(pos) || pos < 0 || Math.abs(pos) > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Tap position must be an integer within the safe number range.");
  }
}
function isIReadableBuffer(value) {
  return typeof value === "object" && value !== null && typeof value.read === "function" && typeof value.canReadMore === "function";
}
function isIWritable(value) {
  return typeof value === "object" && value !== null && typeof value.appendBytes === "function" && typeof value.isValid === "function";
}

class TapBase {
  pos;
  constructor(pos) {
    this.pos = pos;
  }
  getPos() {
    return this.pos;
  }
  _testOnlyResetPos() {
    this.pos = 0;
  }
}

class ReadableTap extends TapBase {
  buffer;
  #lengthHint;
  constructor(buf, pos = 0) {
    assertValidPosition(pos);
    let buffer;
    let lengthHint;
    if (buf instanceof ArrayBuffer) {
      buffer = new InMemoryReadableBuffer(buf);
      lengthHint = buf.byteLength;
    } else if (isIReadableBuffer(buf)) {
      buffer = buf;
    } else {
      throw new TypeError("ReadableTap requires an ArrayBuffer or IReadableBuffer.");
    }
    super(pos);
    this.buffer = buffer;
    this.#lengthHint = lengthHint;
  }
  async isValid() {
    try {
      const probe = await this.buffer.read(this.pos, 0);
      return probe !== undefined;
    } catch (err) {
      if (err instanceof RangeError) {
        return false;
      }
      throw err;
    }
  }
  async canReadMore() {
    return await this.buffer.canReadMore(this.pos);
  }
  async _testOnlyBuf() {
    const readLength = this.#lengthHint ?? this.pos;
    if (readLength <= 0) {
      return new Uint8Array;
    }
    const bytes = await this.buffer.read(0, readLength);
    if (bytes) {
      return bytes.slice();
    } else {
      return new Uint8Array;
    }
  }
  async getValue() {
    const bytes = await this.buffer.read(0, this.pos);
    if (!bytes) {
      throw new RangeError("Tap position exceeds buffer length.");
    }
    return bytes;
  }
  async getByteAt(position) {
    const bytes = await this.buffer.read(position, 1);
    if (!bytes) {
      throw new RangeError("Attempt to read beyond buffer bounds.");
    }
    return bytes[0];
  }
  async readBoolean() {
    const value = await this.getByteAt(this.pos);
    this.pos += 1;
    return !!value;
  }
  skipBoolean() {
    this.pos++;
  }
  async readInt() {
    return bigIntToSafeNumber(await this.readLong(), "readInt value");
  }
  async readLong() {
    let pos = this.pos;
    let shift = 0n;
    let result = 0n;
    let byte;
    do {
      byte = await this.getByteAt(pos++);
      result |= BigInt(byte & 127) << shift;
      shift += 7n;
    } while ((byte & 128) !== 0 && shift < 70n);
    while ((byte & 128) !== 0) {
      byte = await this.getByteAt(pos++);
      result |= BigInt(byte & 127) << shift;
      shift += 7n;
    }
    this.pos = pos;
    return result >> 1n ^ -(result & 1n);
  }
  async skipInt() {
    await this.skipLong();
  }
  async skipLong() {
    let pos = this.pos;
    while (await this.getByteAt(pos++) & 128) {}
    this.pos = pos;
  }
  async readFloat() {
    const pos = this.pos;
    this.pos += 4;
    const bytes = await this.buffer.read(pos, 4);
    if (!bytes) {
      throw new RangeError("Attempt to read beyond buffer bounds.");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getFloat32(0, true);
  }
  skipFloat() {
    this.pos += 4;
  }
  async readDouble() {
    const pos = this.pos;
    this.pos += 8;
    const bytes = await this.buffer.read(pos, 8);
    if (!bytes) {
      throw new RangeError("Attempt to read beyond buffer bounds.");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getFloat64(0, true);
  }
  skipDouble() {
    this.pos += 8;
  }
  async readFixed(len) {
    const pos = this.pos;
    this.pos += len;
    const bytes = await this.buffer.read(pos, len);
    if (!bytes) {
      throw new RangeError("Attempt to read beyond buffer bounds.");
    }
    return bytes;
  }
  skipFixed(len) {
    this.pos += len;
  }
  async readBytes() {
    const length = bigIntToSafeNumber(await this.readLong(), "readBytes length");
    return await this.readFixed(length);
  }
  async skipBytes() {
    const len = bigIntToSafeNumber(await this.readLong(), "skipBytes length");
    this.pos += len;
  }
  async skipString() {
    const len = bigIntToSafeNumber(await this.readLong(), "skipString length");
    this.pos += len;
  }
  async readString() {
    const len = bigIntToSafeNumber(await this.readLong(), "readString length");
    const bytes = await this.readFixed(len);
    return decode(bytes);
  }
  async matchBoolean(tap) {
    const val1 = await this.readBoolean();
    const val2 = await tap.readBoolean();
    return Number(val1) - Number(val2);
  }
  async matchInt(tap) {
    return await this.matchLong(tap);
  }
  async matchLong(tap) {
    const n1 = await this.readLong();
    const n2 = await tap.readLong();
    return n1 === n2 ? 0 : n1 < n2 ? -1 : 1;
  }
  async matchFloat(tap) {
    const n1 = await this.readFloat();
    const n2 = await tap.readFloat();
    return n1 === n2 ? 0 : n1 < n2 ? -1 : 1;
  }
  async matchDouble(tap) {
    const n1 = await this.readDouble();
    const n2 = await tap.readDouble();
    return n1 === n2 ? 0 : n1 < n2 ? -1 : 1;
  }
  async matchFixed(tap, len) {
    const fixed1 = await this.readFixed(len);
    const fixed2 = await tap.readFixed(len);
    return compareUint8Arrays(fixed1, fixed2);
  }
  async matchBytes(tap) {
    return await this.matchString(tap);
  }
  async matchString(tap) {
    const l1 = bigIntToSafeNumber(await this.readLong(), "matchString length this");
    const bytes1 = await this.readFixed(l1);
    const l2 = bigIntToSafeNumber(await tap.readLong(), "matchString length tap");
    const bytes2 = await tap.readFixed(l2);
    return compareUint8Arrays(bytes1, bytes2);
  }
  async unpackLongBytes() {
    const res = new Uint8Array(8);
    let n = 0;
    let i = 0;
    let j = 6;
    let pos = this.pos;
    let b = await this.getByteAt(pos++);
    const neg = b & 1;
    res.fill(0);
    n |= (b & 127) >> 1;
    while (b & 128) {
      b = await this.getByteAt(pos++);
      n |= (b & 127) << j;
      j += 7;
      if (j >= 8) {
        j -= 8;
        res[i++] = n;
        n >>= 8;
      }
    }
    res[i] = n;
    if (neg) {
      invert(res, 8);
    }
    this.pos = pos;
    return res;
  }
}

class WritableTap extends TapBase {
  buffer;
  constructor(buf, pos = 0) {
    assertValidPosition(pos);
    let buffer;
    if (buf instanceof ArrayBuffer) {
      buffer = new InMemoryWritableBuffer(buf, pos);
    } else if (isIWritable(buf)) {
      buffer = buf;
    } else {
      throw new TypeError("WritableTap requires an ArrayBuffer or IWritableBuffer.");
    }
    super(pos);
    this.buffer = buffer;
  }
  async appendRawBytes(bytes) {
    if (bytes.length === 0) {
      return;
    }
    this.pos += bytes.length;
    await this.buffer.appendBytes(bytes);
  }
  async isValid() {
    return await this.buffer.isValid();
  }
  async writeBoolean(value) {
    await this.appendRawBytes(Uint8Array.of(value ? 1 : 0));
  }
  async writeInt(n) {
    await this.writeLong(BigInt(n));
  }
  async writeLong(value) {
    let n = value;
    if (n < 0n) {
      n = (-n << 1n) - 1n;
    } else {
      n <<= 1n;
    }
    const bytes = [];
    while (n >= 0x80n) {
      bytes.push(Number(n & 0x7fn) | 128);
      n >>= 7n;
    }
    bytes.push(Number(n));
    await this.appendRawBytes(Uint8Array.from(bytes));
  }
  async writeFloat(value) {
    const buffer = new ArrayBuffer(4);
    const view = new DataView(buffer);
    view.setFloat32(0, value, true);
    await this.appendRawBytes(new Uint8Array(buffer));
  }
  async writeDouble(value) {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setFloat64(0, value, true);
    await this.appendRawBytes(new Uint8Array(buffer));
  }
  async writeFixed(buf, len) {
    const length = len ?? buf.length;
    if (length === 0) {
      return;
    }
    await this.appendRawBytes(buf.slice(0, length));
  }
  async writeBytes(buf) {
    const len = buf.length;
    await this.writeLong(BigInt(len));
    await this.writeFixed(buf, len);
  }
  async writeString(str) {
    const encoded = encode(str);
    const len = encoded.length;
    await this.writeLong(BigInt(len));
    await this.writeFixed(encoded, len);
  }
  async writeBinary(str, len) {
    if (len <= 0) {
      return;
    }
    const bytes = new Uint8Array(len);
    for (let i = 0;i < len; i++) {
      bytes[i] = str.charCodeAt(i) & 255;
    }
    await this.appendRawBytes(bytes);
  }
  async packLongBytes(arr) {
    const bufView = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
    const neg = (bufView.getUint8(7) & 128) >> 7;
    let j = 1;
    let k = 0;
    let m = 3;
    let n;
    if (neg) {
      invert(arr, 8);
      n = 1;
    } else {
      n = 0;
    }
    const parts = [
      readUIntLE(bufView, 0, 3),
      readUIntLE(bufView, 3, 3),
      readUIntLE(bufView, 6, 2)
    ];
    while (m && !parts[--m]) {}
    const emitted = [];
    while (k < m) {
      n |= parts[k++] << j;
      j += 24;
      while (j > 7) {
        emitted.push(n & 127 | 128);
        n >>= 7;
        j -= 7;
      }
    }
    n |= parts[m] << j;
    do {
      const byte = n & 127;
      n >>= 7;
      if (n) {
        emitted.push(byte | 128);
      } else {
        emitted.push(byte);
      }
    } while (n);
    if (neg) {
      invert(arr, 8);
    }
    await this.appendRawBytes(Uint8Array.from(emitted));
  }
}

// node_modules/@sachitv/avro-typescript/src/schemas/type.js
class Type {
}

// node_modules/@sachitv/avro-typescript/src/schemas/resolver.js
class Resolver {
  readerType;
  constructor(readerType) {
    this.readerType = readerType;
  }
}

// node_modules/@sachitv/avro-typescript/src/schemas/json.js
function _safeJSONStringify(obj, indent = 2) {
  const cache = [];
  const retVal = JSON.stringify(obj, (_key, value) => {
    if (typeof value === "bigint")
      return String(value);
    if (typeof value === "object" && value !== null) {
      if (cache.includes(value))
        return "[Circular]";
      cache.push(value);
    }
    return value;
  }, indent);
  cache.length = 0;
  return retVal;
}
function safeStringify(value) {
  if (typeof value === "string" || typeof value === "bigint" || typeof value === "number" || typeof value === "boolean" || value === null || typeof value === "undefined") {
    return String(value);
  }
  const jsonStr = _safeJSONStringify(value);
  if (jsonStr === undefined) {
    return String(value);
  }
  return `
${jsonStr}
`;
}

// node_modules/@sachitv/avro-typescript/src/schemas/base_type.js
class BaseType extends Type {
  async fromBuffer(buffer) {
    const tap = new ReadableTap(buffer);
    const value = await this.read(tap);
    if (!await tap.isValid() || tap.getPos() !== buffer.byteLength) {
      throw new Error("Insufficient data for type");
    }
    return value;
  }
  isValid(value, opts) {
    return this.check(value, opts?.errorHook, []);
  }
  createResolver(writerType) {
    if (this.constructor === writerType.constructor) {
      return new class extends Resolver {
        async read(tap) {
          return await this.readerType.read(tap);
        }
      }(this);
    } else {
      throw new Error(`Schema evolution not supported from writer type: ${safeStringify(writerType.toJSON())} to reader type: ${safeStringify(this.toJSON())}`);
    }
  }
}

// node_modules/@sachitv/avro-typescript/src/schemas/error.js
class ValidationError extends Error {
  path;
  value;
  type;
  constructor(path, invalidValue, schemaType) {
    const serializedValue = safeStringify(invalidValue);
    const serializedJSON = safeStringify(schemaType.toJSON());
    let message = `Invalid value: '${serializedValue}' for type: ${serializedJSON}`;
    if (path.length > 0) {
      message += ` at path: ${renderPathAsTree(path)}`;
    }
    super(message);
    this.name = "ValidationError";
    this.path = path;
    this.value = invalidValue;
    this.type = schemaType;
  }
}
function throwInvalidError(path, invalidValue, schemaType) {
  throw new ValidationError(path, invalidValue, schemaType);
}
function renderPathAsTree(path) {
  if (path.length === 0)
    return "";
  let result = path[0];
  for (let i = 1;i < path.length; i++) {
    result += `
` + "  ".repeat(i) + path[i];
  }
  if (path.length > 1) {
    result = `
` + result;
  }
  return result;
}

// node_modules/@sachitv/avro-typescript/src/internal/varint.js
function calculateVarintSize(value) {
  const val = typeof value === "number" ? BigInt(value) : value;
  const zigzag = val << 1n ^ val >> 63n;
  if (zigzag < 128n)
    return 1;
  if (zigzag < 16384n)
    return 2;
  if (zigzag < 2097152n)
    return 3;
  if (zigzag < 268435456n)
    return 4;
  if (zigzag < 34359738368n)
    return 5;
  if (zigzag < 4398046511104n)
    return 6;
  if (zigzag < 562949953421312n)
    return 7;
  if (zigzag < 72057594037927936n)
    return 8;
  if (zigzag < 9223372036854775808n)
    return 9;
  return 10;
}

// node_modules/@sachitv/avro-typescript/src/schemas/complex/array_type.js
async function readArrayInto(tap, readElement, collect) {
  while (true) {
    const rawCount = await tap.readLong();
    if (rawCount === 0n) {
      break;
    }
    let count = bigIntToSafeNumber(rawCount, "Array block length");
    if (count < 0) {
      count = -count;
      await tap.skipLong();
    }
    for (let i = 0;i < count; i++) {
      collect(await readElement(tap));
    }
  }
}

class ArrayType extends BaseType {
  #itemsType;
  constructor(params) {
    super();
    if (!params.items) {
      throw new Error("ArrayType requires an items type.");
    }
    this.#itemsType = params.items;
  }
  getItemsType() {
    return this.#itemsType;
  }
  check(value, errorHook, path = []) {
    if (!Array.isArray(value)) {
      if (errorHook) {
        errorHook(path.slice(), value, this);
      }
      return false;
    }
    let isValid = true;
    for (let i = 0;i < value.length; i++) {
      const element = value[i];
      const elementPath = errorHook ? [
        ...path,
        String(i)
      ] : undefined;
      const validElement = this.#itemsType.check(element, errorHook, elementPath);
      if (!validElement) {
        if (!errorHook) {
          return false;
        }
        isValid = false;
      }
    }
    return isValid;
  }
  async write(tap, value) {
    if (!Array.isArray(value)) {
      throwInvalidError([], value, this);
    }
    if (value.length > 0) {
      await tap.writeLong(BigInt(value.length));
      for (const element of value) {
        await this.#itemsType.write(tap, element);
      }
    }
    await tap.writeLong(0n);
  }
  async skip(tap) {
    while (true) {
      const rawCount = await tap.readLong();
      if (rawCount === 0n) {
        break;
      }
      let count = bigIntToSafeNumber(rawCount, "Array block length");
      if (count < 0) {
        count = -count;
        const blockSize = Number(await tap.readLong());
        if (blockSize > 0) {
          await tap.skipFixed(blockSize);
        }
      } else {
        for (let i = 0;i < count; i++) {
          await this.#itemsType.skip(tap);
        }
      }
    }
  }
  async read(tap) {
    const result = [];
    await readArrayInto(tap, async (innerTap) => await this.#itemsType.read(innerTap), (value) => {
      result.push(value);
    });
    return result;
  }
  async toBuffer(value) {
    if (!Array.isArray(value)) {
      throwInvalidError([], value, this);
    }
    const elementBuffers = value.length === 0 ? [] : await Promise.all(value.map(async (element) => new Uint8Array(await this.#itemsType.toBuffer(element))));
    let totalSize = 1;
    if (value.length > 0) {
      totalSize += calculateVarintSize(value.length);
      for (const buf of elementBuffers) {
        totalSize += buf.byteLength;
      }
    }
    const buffer = new ArrayBuffer(totalSize);
    const tap = new WritableTap(buffer);
    if (value.length > 0) {
      await tap.writeLong(BigInt(value.length));
      for (const buf of elementBuffers) {
        await tap.writeFixed(buf);
      }
    }
    await tap.writeLong(0n);
    return buffer;
  }
  cloneFromValue(value) {
    if (!Array.isArray(value)) {
      throw new Error("Cannot clone non-array value.");
    }
    return value.map((element) => this.#itemsType.cloneFromValue(element));
  }
  compare(val1, val2) {
    const len = Math.min(val1.length, val2.length);
    for (let i = 0;i < len; i++) {
      const comparison = this.#itemsType.compare(val1[i], val2[i]);
      if (comparison !== 0) {
        return comparison;
      }
    }
    if (val1.length === val2.length) {
      return 0;
    }
    return val1.length < val2.length ? -1 : 1;
  }
  random() {
    const length = Math.ceil(Math.random() * 10);
    const result = [];
    for (let i = 0;i < length; i++) {
      result.push(this.#itemsType.random());
    }
    return result;
  }
  toJSON() {
    return {
      type: "array",
      items: this.#itemsType.toJSON()
    };
  }
  async match(tap1, tap2) {
    let n1 = await this.#readArraySize(tap1);
    let n2 = await this.#readArraySize(tap2);
    let f;
    while (n1 !== 0n && n2 !== 0n) {
      f = await this.#itemsType.match(tap1, tap2);
      if (f !== 0) {
        return f;
      }
      if (n1 > 0n) {
        n1--;
      }
      if (n1 === 0n) {
        n1 = await this.#readArraySize(tap1);
      }
      if (n2 > 0n) {
        n2--;
      }
      if (n2 === 0n) {
        n2 = await this.#readArraySize(tap2);
      }
    }
    return n1 === n2 ? 0 : n1 < n2 ? -1 : 1;
  }
  async#readArraySize(tap) {
    let n = await tap.readLong();
    if (n < 0n) {
      n = -n;
      await tap.skipLong();
    }
    return n;
  }
  createResolver(writerType) {
    if (!(writerType instanceof ArrayType)) {
      return super.createResolver(writerType);
    }
    const itemResolver = this.#itemsType.createResolver(writerType.getItemsType());
    return new ArrayResolver(this, itemResolver);
  }
}

class ArrayResolver extends Resolver {
  #itemResolver;
  constructor(reader, itemResolver) {
    super(reader);
    this.#itemResolver = itemResolver;
  }
  async read(tap) {
    const result = [];
    await readArrayInto(tap, async (innerTap) => await this.#itemResolver.read(innerTap), (value) => {
      result.push(value);
    });
    return result;
  }
}

// node_modules/@sachitv/avro-typescript/src/schemas/primitive/fixed_size_base_type.js
class FixedSizeBaseType extends BaseType {
  async toBuffer(value) {
    this.check(value, throwInvalidError, []);
    const size = this.sizeBytes();
    const buf = new ArrayBuffer(size);
    const tap = new WritableTap(buf);
    await this.write(tap, value);
    return buf;
  }
  async skip(tap) {
    await tap.skipFixed(this.sizeBytes());
  }
}

// node_modules/@sachitv/avro-typescript/src/schemas/primitive/boolean_type.js
class BooleanType extends FixedSizeBaseType {
  check(value, errorHook, path = []) {
    const isValid = typeof value === "boolean";
    if (!isValid && errorHook) {
      errorHook(path, value, this);
    }
    return isValid;
  }
  async read(tap) {
    return await tap.readBoolean();
  }
  async write(tap, value) {
    if (typeof value !== "boolean") {
      throwInvalidError([], value, this);
    }
    await tap.writeBoolean(value);
  }
  async skip(tap) {
    await tap.skipBoolean();
  }
  sizeBytes() {
    return 1;
  }
  cloneFromValue(value) {
    this.check(value, throwInvalidError, []);
    return value;
  }
  compare(val1, val2) {
    return val1 === val2 ? 0 : val1 ? 1 : -1;
  }
  random() {
    return Math.random() < 0.5;
  }
  toJSON() {
    return "boolean";
  }
  async match(tap1, tap2) {
    return await tap1.matchBoolean(tap2);
  }
}

// node_modules/@sachitv/avro-typescript/src/schemas/primitive/primitive_type.js
class PrimitiveType extends BaseType {
  cloneFromValue(value) {
    this.check(value, throwInvalidError, []);
    return value;
  }
  compare(val1, val2) {
    if (val1 < val2)
      return -1;
    if (val1 > val2)
      return 1;
    return 0;
  }
}

// node_modules/@sachitv/avro-typescript/src/schemas/primitive/bytes_type.js
class BytesType extends PrimitiveType {
  check(value, errorHook, path = []) {
    const isValid = value instanceof Uint8Array;
    if (!isValid && errorHook) {
      errorHook(path, value, this);
    }
    return isValid;
  }
  async read(tap) {
    return await tap.readBytes();
  }
  async write(tap, value) {
    if (!(value instanceof Uint8Array)) {
      throwInvalidError([], value, this);
    }
    await tap.writeBytes(value);
  }
  async skip(tap) {
    await tap.skipBytes();
  }
  async toBuffer(value) {
    this.check(value, throwInvalidError, []);
    const lengthSize = calculateVarintSize(value.length);
    const totalSize = lengthSize + value.length;
    const buf = new ArrayBuffer(totalSize);
    const tap = new WritableTap(buf);
    await this.write(tap, value);
    return buf;
  }
  createResolver(writerType) {
    if (writerType.toJSON() === "string") {
      return new class extends Resolver {
        async read(tap) {
          const str = await tap.readString();
          const encoder2 = new TextEncoder;
          return encoder2.encode(str);
        }
      }(this);
    } else {
      return super.createResolver(writerType);
    }
  }
  compare(val1, val2) {
    const len1 = val1.length;
    const len2 = val2.length;
    const len = Math.min(len1, len2);
    for (let i = 0;i < len; i++) {
      if (val1[i] !== val2[i]) {
        return val1[i] < val2[i] ? -1 : 1;
      }
    }
    return len1 < len2 ? -1 : len1 > len2 ? 1 : 0;
  }
  cloneFromValue(value) {
    let bytes;
    if (value instanceof Uint8Array) {
      bytes = value;
    } else if (typeof value === "string") {
      bytes = BytesType.#fromJsonString(value);
    } else {
      throwInvalidError([], value, this);
    }
    this.check(bytes, throwInvalidError, []);
    return new Uint8Array(bytes);
  }
  random() {
    const len = Math.ceil(Math.random() * 31) + 1;
    const buf = new Uint8Array(len);
    for (let i = 0;i < len; i++) {
      buf[i] = Math.floor(Math.random() * 256);
    }
    return buf;
  }
  static #fromJsonString(value) {
    const bytes = new Uint8Array(value.length);
    for (let i = 0;i < value.length; i++) {
      bytes[i] = value.charCodeAt(i) & 255;
    }
    return bytes;
  }
  toJSON() {
    return "bytes";
  }
  async match(tap1, tap2) {
    return await tap1.matchBytes(tap2);
  }
}

// node_modules/@sachitv/avro-typescript/src/schemas/primitive/int_type.js
class IntType extends PrimitiveType {
  check(value, errorHook, path = []) {
    const isValid = typeof value === "number" && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
    if (!isValid && errorHook) {
      errorHook(path, value, this);
    }
    return isValid;
  }
  async read(tap) {
    return await tap.readInt();
  }
  async write(tap, value) {
    if (!this.check(value)) {
      throwInvalidError([], value, this);
    }
    await tap.writeInt(value);
  }
  async skip(tap) {
    await tap.skipInt();
  }
  async toBuffer(value) {
    this.check(value, throwInvalidError, []);
    const size = calculateVarintSize(value);
    const buf = new ArrayBuffer(size);
    const tap = new WritableTap(buf);
    await this.write(tap, value);
    return buf;
  }
  compare(val1, val2) {
    return val1 < val2 ? -1 : val1 > val2 ? 1 : 0;
  }
  random() {
    return Math.floor(Math.random() * 1000);
  }
  toJSON() {
    return "int";
  }
  async match(tap1, tap2) {
    return await tap1.matchInt(tap2);
  }
}

// node_modules/@sachitv/avro-typescript/src/schemas/primitive/long_type.js
var MIN_LONG = -(1n << 63n);
var MAX_LONG = (1n << 63n) - 1n;

class LongType extends PrimitiveType {
  check(value, errorHook, path = []) {
    const isValid = typeof value === "bigint" && value >= MIN_LONG && value <= MAX_LONG;
    if (!isValid && errorHook) {
      errorHook(path, value, this);
    }
    return isValid;
  }
  async read(tap) {
    return await tap.readLong();
  }
  async write(tap, value) {
    if (!this.check(value)) {
      throwInvalidError([], value, this);
    }
    await tap.writeLong(value);
  }
  async skip(tap) {
    await tap.skipLong();
  }
  async toBuffer(value) {
    this.check(value, throwInvalidError, []);
    const size = calculateVarintSize(value);
    const buf = new ArrayBuffer(size);
    const tap = new WritableTap(buf);
    await this.write(tap, value);
    return buf;
  }
  compare(val1, val2) {
    return val1 < val2 ? -1 : val1 > val2 ? 1 : 0;
  }
  random() {
    return BigInt(Math.floor(Math.random() * 1000));
  }
  cloneFromValue(value) {
    if (typeof value === "bigint") {
      this.check(value, throwInvalidError, []);
      return value;
    }
    if (typeof value === "number" && Number.isInteger(value)) {
      const candidate = BigInt(value);
      this.check(candidate, throwInvalidError, []);
      return candidate;
    }
    throwInvalidError([], value, this);
  }
  createResolver(writerType) {
    if (writerType instanceof IntType) {
      return new class extends Resolver {
        async read(tap) {
          const intValue = await tap.readInt();
          return BigInt(intValue);
        }
      }(this);
    } else {
      return super.createResolver(writerType);
    }
  }
  toJSON() {
    return "long";
  }
  async match(tap1, tap2) {
    return await tap1.matchLong(tap2);
  }
}

// node_modules/@sachitv/avro-typescript/src/schemas/primitive/float_type.js
class FloatType extends FixedSizeBaseType {
  check(value, errorHook, path = []) {
    const isValid = typeof value === "number";
    if (!isValid && errorHook) {
      errorHook(path, value, this);
    }
    return isValid;
  }
  async read(tap) {
    return await tap.readFloat();
  }
  async write(tap, value) {
    if (!this.check(value)) {
      throwInvalidError([], value, this);
    }
    await tap.writeFloat(value);
  }
  async skip(tap) {
    await tap.skipFloat();
  }
  sizeBytes() {
    return 4;
  }
  cloneFromValue(value) {
    this.check(value, throwInvalidError, []);
    return value;
  }
  compare(val1, val2) {
    return val1 < val2 ? -1 : val1 > val2 ? 1 : 0;
  }
  random() {
    return Math.random() * 1000;
  }
  createResolver(writerType) {
    if (writerType instanceof IntType) {
      return new class extends Resolver {
        async read(tap) {
          const intValue = await tap.readInt();
          return intValue;
        }
      }(this);
    } else if (writerType instanceof LongType) {
      return new class extends Resolver {
        async read(tap) {
          const longValue = await tap.readLong();
          return Number(longValue);
        }
      }(this);
    } else {
      return super.createResolver(writerType);
    }
  }
  toJSON() {
    return "float";
  }
  async match(tap1, tap2) {
    return await tap1.matchFloat(tap2);
  }
}

// node_modules/@sachitv/avro-typescript/src/schemas/primitive/double_type.js
class DoubleType extends FixedSizeBaseType {
  check(value, errorHook, path = []) {
    const isValid = typeof value === "number";
    if (!isValid && errorHook) {
      errorHook(path, value, this);
    }
    return isValid;
  }
  async read(tap) {
    return await tap.readDouble();
  }
  async write(tap, value) {
    if (!this.check(value)) {
      throwInvalidError([], value, this);
    }
    await tap.writeDouble(value);
  }
  async skip(tap) {
    await tap.skipDouble();
  }
  sizeBytes() {
    return 8;
  }
  cloneFromValue(value) {
    this.check(value, throwInvalidError, []);
    return value;
  }
  compare(val1, val2) {
    return val1 < val2 ? -1 : val1 > val2 ? 1 : 0;
  }
  random() {
    return Math.random();
  }
  createResolver(writerType) {
    if (writerType instanceof IntType) {
      return new class extends Resolver {
        async read(tap) {
          const intValue = await tap.readInt();
          return intValue;
        }
      }(this);
    } else if (writerType instanceof LongType) {
      return new class extends Resolver {
        async read(tap) {
          const longValue = await tap.readLong();
          return Number(longValue);
        }
      }(this);
    } else if (writerType instanceof FloatType) {
      return new class extends Resolver {
        async read(tap) {
          const floatValue = await tap.readFloat();
          return floatValue;
        }
      }(this);
    } else {
      return super.createResolver(writerType);
    }
  }
  toJSON() {
    return "double";
  }
  async match(tap1, tap2) {
    return await tap1.matchDouble(tap2);
  }
}

// node_modules/@sachitv/avro-typescript/src/schemas/complex/named_type.js
class NamedType extends BaseType {
  #fullName;
  #namespace;
  #aliases;
  constructor(resolvedNames) {
    super();
    this.#fullName = resolvedNames.fullName;
    this.#namespace = resolvedNames.namespace;
    this.#aliases = resolvedNames.aliases;
  }
  getFullName() {
    return this.#fullName;
  }
  getNamespace() {
    return this.#namespace;
  }
  getAliases() {
    return this.#aliases.slice();
  }
  matchesName(name) {
    return name === this.#fullName || this.#aliases.includes(name);
  }
}

// node_modules/@sachitv/avro-typescript/src/schemas/complex/resolve_names.js
var NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
function isValidName(name) {
  return NAME_PATTERN.test(name);
}
var PRIMITIVE_TYPE_NAMES = new Set([
  "null",
  "boolean",
  "int",
  "long",
  "float",
  "double",
  "bytes",
  "string"
]);
function resolveNames({ name, namespace, aliases = [] }) {
  const fullName = qualifyName(name, namespace);
  const typeNamespace = getNamespaceFromName(fullName);
  const resolvedAliases = [];
  const seen = new Set;
  seen.add(fullName);
  for (const alias of aliases) {
    const qualified = qualifyAlias(alias, typeNamespace);
    if (!seen.has(qualified)) {
      seen.add(qualified);
      resolvedAliases.push(qualified);
    }
  }
  return {
    fullName,
    aliases: resolvedAliases,
    namespace: typeNamespace ?? ""
  };
}
function qualifyName(name, namespace) {
  if (!name) {
    throw new Error("Avro name is required.");
  }
  let qualified = name;
  if (namespace && !name.includes(".")) {
    qualified = `${namespace}.${name}`;
  }
  validateFullName(qualified, false);
  return qualified;
}
function qualifyAlias(alias, namespace) {
  if (!alias) {
    throw new Error("Avro alias is required.");
  }
  let qualified = alias;
  if (namespace && !alias.includes(".")) {
    qualified = `${namespace}.${alias}`;
  }
  validateFullName(qualified, true);
  return qualified;
}
function validateFullName(name, isAlias) {
  const parts = name.split(".");
  parts.forEach((part) => {
    if (!isValidName(part)) {
      throw new Error(`${isAlias ? "Invalid Avro alias: " : "Invalid Avro name: "}${name}`);
    }
  });
  const tail = parts[parts.length - 1];
  if (PRIMITIVE_TYPE_NAMES.has(tail)) {
    throw new Error(`${isAlias ? "Cannot rename primitive Avro alias: " : "Cannot rename primitive Avro type: "}${tail}`);
  }
}
function getNamespaceFromName(name) {
  const parts = name.split(".");
  if (parts.length <= 1) {
    return;
  }
  parts.pop();
  return parts.join(".");
}

// node_modules/@sachitv/avro-typescript/src/schemas/complex/enum_type.js
class EnumType extends NamedType {
  #symbols;
  #indices;
  #default;
  constructor(params) {
    if (!Array.isArray(params.symbols) || params.symbols.length === 0) {
      throw new Error("EnumType requires a non-empty symbols array.");
    }
    const { symbols, default: defaultValue, ...nameInfo } = params;
    super(nameInfo);
    this.#symbols = symbols.slice();
    this.#indices = new Map;
    this.#symbols.forEach((symbol, index) => {
      if (!isValidName(symbol)) {
        throw new Error(`Invalid enum symbol: ${symbol}`);
      }
      if (this.#indices.has(symbol)) {
        throw new Error(`Duplicate enum symbol: ${symbol}`);
      }
      this.#indices.set(symbol, index);
    });
    if (defaultValue !== undefined) {
      if (!this.#symbols.includes(defaultValue)) {
        throw new Error("Default value must be a member of the symbols array.");
      }
      this.#default = defaultValue;
    }
  }
  getSymbols() {
    return this.#symbols.slice();
  }
  getDefault() {
    return this.#default;
  }
  check(value, errorHook, path = []) {
    const isValid = typeof value === "string" && this.#indices.has(value);
    if (!isValid && errorHook) {
      errorHook(path, value, this);
    }
    return isValid;
  }
  async write(tap, value) {
    const index = this.#indices.get(value);
    if (index === undefined) {
      throwInvalidError([], value, this);
    }
    await tap.writeLong(BigInt(index));
  }
  async skip(tap) {
    await tap.skipLong();
  }
  async read(tap) {
    const rawIndex = await tap.readLong();
    const index = Number(rawIndex);
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.#symbols.length) {
      throw new Error(`Invalid enum index ${rawIndex.toString()} for ${this.getFullName()}`);
    }
    return this.#symbols[index];
  }
  async toBuffer(value) {
    this.check(value, throwInvalidError, []);
    const index = this.#indices.get(value);
    const size = calculateVarintSize(index);
    const buffer = new ArrayBuffer(size);
    const tap = new WritableTap(buffer);
    await this.write(tap, value);
    return buffer;
  }
  cloneFromValue(value) {
    if (!this.check(value)) {
      throwInvalidError([], value, this);
    }
    return value;
  }
  compare(val1, val2) {
    const i1 = this.#indices.get(val1);
    const i2 = this.#indices.get(val2);
    if (i1 === undefined || i2 === undefined) {
      throw new Error("Cannot compare values not present in the enum.");
    }
    return i1 - i2;
  }
  random() {
    const idx = Math.floor(Math.random() * this.#symbols.length);
    return this.#symbols[idx];
  }
  toJSON() {
    return "enum";
  }
  async match(tap1, tap2) {
    return await tap1.matchLong(tap2);
  }
  createResolver(writerType) {
    if (!(writerType instanceof EnumType)) {
      return super.createResolver(writerType);
    }
    const acceptableNames = new Set([
      this.getFullName(),
      ...this.getAliases()
    ]);
    const writerName = writerType.getFullName();
    if (!acceptableNames.has(writerName)) {
      throw new Error(`Schema evolution not supported from writer type: ${writerType.getFullName()} to reader type: ${this.getFullName()}`);
    }
    const writerSymbols = writerType.getSymbols();
    const allSymbolsSupported = writerSymbols.every((symbol) => this.#indices.has(symbol));
    if (allSymbolsSupported) {
      return new class extends Resolver {
        #writer;
        constructor(reader, writer) {
          super(reader);
          this.#writer = writer;
        }
        async read(tap) {
          return await this.#writer.read(tap);
        }
      }(this, writerType);
    } else if (this.#default !== undefined) {
      return new class extends Resolver {
        #writer;
        #reader;
        constructor(reader, writer) {
          super(reader);
          this.#reader = reader;
          this.#writer = writer;
        }
        async read(tap) {
          const writerSymbol = await this.#writer.read(tap);
          if (this.#reader.#indices.has(writerSymbol)) {
            return writerSymbol;
          } else {
            return this.#reader.#default;
          }
        }
      }(this, writerType);
    } else {
      throw new Error(`Schema evolution not supported from writer type: ${writerType.getFullName()} to reader type: ${this.getFullName()}`);
    }
  }
}

// node_modules/@sachitv/avro-typescript/src/schemas/complex/fixed_type.js
class FixedType extends NamedType {
  #size;
  constructor(params) {
    const { size, ...names } = params;
    if (!Number.isInteger(size) || size < 1) {
      throw new Error(`Invalid fixed size: ${size}. Size must be a positive integer.`);
    }
    super(names);
    this.#size = size;
  }
  sizeBytes() {
    return this.#size;
  }
  async toBuffer(value) {
    this.check(value, throwInvalidError, []);
    const size = this.sizeBytes();
    const buf = new ArrayBuffer(size);
    const tap = new WritableTap(buf);
    await this.write(tap, value);
    return buf;
  }
  async skip(tap) {
    await tap.skipFixed(this.sizeBytes());
  }
  getSize() {
    return this.#size;
  }
  check(value, errorHook, path = []) {
    const isValid = value instanceof Uint8Array && value.length === this.#size;
    if (!isValid && errorHook) {
      errorHook(path.slice(), value, this);
    }
    return isValid;
  }
  async read(tap) {
    return await tap.readFixed(this.#size);
  }
  async write(tap, value) {
    if (!(value instanceof Uint8Array) || value.length !== this.#size) {
      throwInvalidError([], value, this);
    }
    await tap.writeFixed(value, this.#size);
  }
  async match(tap1, tap2) {
    return await tap1.matchFixed(tap2, this.#size);
  }
  compare(val1, val2) {
    if (!(val1 instanceof Uint8Array) || !(val2 instanceof Uint8Array)) {
      throw new Error("Fixed comparison requires Uint8Array values.");
    }
    if (val1.length !== this.#size || val2.length !== this.#size) {
      throw new Error(`Fixed values must be exactly ${this.#size} bytes.`);
    }
    return compareUint8Arrays(val1, val2);
  }
  cloneFromValue(value) {
    let bytes;
    if (value instanceof Uint8Array) {
      bytes = value;
    } else if (typeof value === "string") {
      bytes = FixedType.#fromJsonString(value);
    } else {
      throwInvalidError([], value, this);
    }
    this.check(bytes, throwInvalidError, []);
    return new Uint8Array(bytes);
  }
  random() {
    const bytes = new Uint8Array(this.#size);
    for (let i = 0;i < this.#size; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
    return bytes;
  }
  toJSON() {
    return {
      name: this.getFullName(),
      type: "fixed",
      size: this.#size
    };
  }
  createResolver(writerType) {
    if (!(writerType instanceof FixedType)) {
      return super.createResolver(writerType);
    }
    const acceptableNames = new Set([
      this.getFullName(),
      ...this.getAliases()
    ]);
    const writerNames = new Set([
      writerType.getFullName(),
      ...writerType.getAliases()
    ]);
    const hasCompatibleName = Array.from(writerNames).some((name) => acceptableNames.has(name));
    if (!hasCompatibleName) {
      throw new Error(`Schema evolution not supported from writer type: ${writerType.getFullName()} to reader type: ${this.getFullName()}`);
    }
    if (this.#size !== writerType.getSize()) {
      throw new Error(`Cannot resolve fixed types with different sizes: writer has ${writerType.getSize()}, reader has ${this.#size}`);
    }
    return new FixedResolver(this);
  }
  static #fromJsonString(value) {
    const bytes = new Uint8Array(value.length);
    for (let i = 0;i < value.length; i++) {
      bytes[i] = value.charCodeAt(i) & 255;
    }
    return bytes;
  }
}

class FixedResolver extends Resolver {
  constructor(reader) {
    super(reader);
  }
  async read(tap) {
    const reader = this.readerType;
    return await reader.read(tap);
  }
}

// node_modules/@sachitv/avro-typescript/src/schemas/complex/map_type.js
async function readMapInto(tap, readValue, collect) {
  while (true) {
    let rawCount = await tap.readLong();
    if (rawCount === 0n) {
      break;
    }
    if (rawCount < 0n) {
      rawCount = -rawCount;
      await tap.skipLong();
    }
    const count = bigIntToSafeNumber(rawCount, "Map block length");
    for (let i = 0;i < count; i++) {
      const key = await tap.readString();
      const value = await readValue(tap);
      collect(key, value);
    }
  }
}

class MapType extends BaseType {
  #valuesType;
  constructor(params) {
    super();
    if (!params.values) {
      throw new Error("MapType requires a values type.");
    }
    this.#valuesType = params.values;
  }
  getValuesType() {
    return this.#valuesType;
  }
  check(value, errorHook, path = []) {
    if (!(value instanceof Map)) {
      if (errorHook) {
        errorHook(path.slice(), value, this);
      }
      return false;
    }
    let isValid = true;
    for (const [key, entry] of value.entries()) {
      if (typeof key !== "string") {
        if (errorHook) {
          errorHook(path.slice(), value, this);
          isValid = false;
          continue;
        }
        return false;
      }
      const entryPath = errorHook ? [
        ...path,
        key
      ] : undefined;
      const validEntry = this.#valuesType.check(entry, errorHook, entryPath);
      if (!validEntry) {
        if (!errorHook) {
          return false;
        }
        isValid = false;
      }
    }
    return isValid;
  }
  async write(tap, value) {
    if (!(value instanceof Map)) {
      throwInvalidError([], value, this);
    }
    if (value.size > 0) {
      await tap.writeLong(BigInt(value.size));
      for (const [key, entry] of value) {
        if (typeof key !== "string") {
          throwInvalidError([], value, this);
        }
        await tap.writeString(key);
        await this.#valuesType.write(tap, entry);
      }
    }
    await tap.writeLong(0n);
  }
  async read(tap) {
    const result = new Map;
    await readMapInto(tap, async (innerTap) => await this.#valuesType.read(innerTap), (key, value) => {
      result.set(key, value);
    });
    return result;
  }
  async skip(tap) {
    while (true) {
      const rawCount = await tap.readLong();
      if (rawCount === 0n) {
        break;
      }
      if (rawCount < 0n) {
        const blockSize = await tap.readLong();
        const size = bigIntToSafeNumber(blockSize, "Map block size");
        if (size > 0) {
          await tap.skipFixed(size);
        }
        continue;
      }
      const count = bigIntToSafeNumber(rawCount, "Map block length");
      for (let i = 0;i < count; i++) {
        await tap.skipString();
        await this.#valuesType.skip(tap);
      }
    }
  }
  async toBuffer(value) {
    if (!(value instanceof Map)) {
      throwInvalidError([], value, this);
    }
    const serializedEntries = [];
    let totalSize = 1;
    for (const [key, entry] of value.entries()) {
      if (typeof key !== "string") {
        throwInvalidError([], value, this);
      }
      const keyBytes = encode(key);
      const valueBytes = new Uint8Array(await this.#valuesType.toBuffer(entry));
      totalSize += calculateVarintSize(keyBytes.length) + keyBytes.length;
      totalSize += valueBytes.length;
      serializedEntries.push({
        keyBytes,
        valueBytes
      });
    }
    if (serializedEntries.length > 0) {
      totalSize += calculateVarintSize(serializedEntries.length);
    }
    const buffer = new ArrayBuffer(totalSize);
    const tap = new WritableTap(buffer);
    if (serializedEntries.length > 0) {
      await tap.writeLong(BigInt(serializedEntries.length));
      for (const { keyBytes, valueBytes } of serializedEntries) {
        await tap.writeLong(BigInt(keyBytes.length));
        await tap.writeFixed(keyBytes);
        await tap.writeFixed(valueBytes);
      }
    }
    await tap.writeLong(0n);
    return buffer;
  }
  cloneFromValue(value) {
    const copy = new Map;
    if (value instanceof Map) {
      for (const [key, entry] of value.entries()) {
        if (typeof key !== "string") {
          throw new Error("Map keys must be strings to clone.");
        }
        copy.set(key, this.#valuesType.cloneFromValue(entry));
      }
      return copy;
    }
    if (!isPlainObject(value)) {
      throw new Error("Cannot clone non-map value.");
    }
    for (const [key, entry] of Object.entries(value)) {
      copy.set(key, this.#valuesType.cloneFromValue(entry));
    }
    return copy;
  }
  compare(_val1, _val2) {
    throw new Error("maps cannot be compared");
  }
  random() {
    const result = new Map;
    const entries = Math.ceil(Math.random() * 10);
    for (let i = 0;i < entries; i++) {
      const key = crypto.randomUUID();
      result.set(key, this.#valuesType.random());
    }
    return result;
  }
  toJSON() {
    return {
      type: "map",
      values: this.#valuesType.toJSON()
    };
  }
  async match(_tap1, _tap2) {
    throw new Error("maps cannot be compared");
  }
  createResolver(writerType) {
    if (!(writerType instanceof MapType)) {
      return super.createResolver(writerType);
    }
    const valueResolver = this.#valuesType.createResolver(writerType.getValuesType());
    return new MapResolver(this, valueResolver);
  }
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class MapResolver extends Resolver {
  #valueResolver;
  constructor(reader, valueResolver) {
    super(reader);
    this.#valueResolver = valueResolver;
  }
  async read(tap) {
    const result = new Map;
    await readMapInto(tap, async (innerTap) => await this.#valueResolver.read(innerTap), (key, value) => {
      result.set(key, value);
    });
    return result;
  }
}

// node_modules/@sachitv/avro-typescript/src/schemas/complex/record_type.js
class RecordField {
  #name;
  #type;
  #aliases;
  #order;
  #hasDefault;
  #defaultValue;
  constructor(params) {
    const { name, type, aliases = [], order = "ascending" } = params;
    if (typeof name !== "string" || !isValidName(name)) {
      throw new Error(`Invalid record field name: ${name}`);
    }
    if (!(type instanceof Type)) {
      throw new Error(`Invalid field type for ${name}`);
    }
    if (!RecordField.#isValidOrder(order)) {
      throw new Error(`Invalid record field order: ${order}`);
    }
    this.#name = name;
    this.#type = type;
    this.#order = order;
    const aliasSet = new Set;
    const resolvedAliases = [];
    for (const alias of aliases) {
      if (typeof alias !== "string" || !isValidName(alias)) {
        throw new Error(`Invalid record field alias: ${alias}`);
      }
      if (!aliasSet.has(alias)) {
        aliasSet.add(alias);
        resolvedAliases.push(alias);
      }
    }
    this.#aliases = resolvedAliases;
    this.#hasDefault = Object.prototype.hasOwnProperty.call(params, "default");
    if (this.#hasDefault) {
      this.#defaultValue = this.#type.cloneFromValue(params.default);
    }
  }
  getName() {
    return this.#name;
  }
  getType() {
    return this.#type;
  }
  getAliases() {
    return this.#aliases.slice();
  }
  getOrder() {
    return this.#order;
  }
  hasDefault() {
    return this.#hasDefault;
  }
  getDefault() {
    if (!this.#hasDefault) {
      throw new Error(`Field '${this.#name}' has no default.`);
    }
    return this.#type.cloneFromValue(this.#defaultValue);
  }
  nameMatches(name) {
    return name === this.#name || this.#aliases.includes(name);
  }
  static #isValidOrder(order) {
    return order === "ascending" || order === "descending" || order === "ignore";
  }
}

class RecordType extends NamedType {
  #fields;
  #fieldNameToIndex;
  #fieldsThunk;
  constructor(params) {
    const { fields, ...names } = params;
    super(names);
    this.#fields = [];
    this.#fieldNameToIndex = new Map;
    if (typeof fields === "function") {
      this.#fieldsThunk = fields;
    } else {
      this.#setFields(fields);
    }
  }
  getFields() {
    this.#ensureFields();
    return this.#fields.slice();
  }
  getField(name) {
    this.#ensureFields();
    const index = this.#fieldNameToIndex.get(name);
    if (index === undefined) {
      return;
    }
    return this.#fields[index];
  }
  check(value, errorHook, path = []) {
    this.#ensureFields();
    if (!this.#isRecord(value)) {
      if (errorHook) {
        errorHook(path.slice(), value, this);
      }
      return false;
    }
    const record = value;
    for (const field of this.#fields) {
      if (!this.#checkField(field, record, errorHook, path)) {
        return false;
      }
    }
    return true;
  }
  async write(tap, value) {
    this.#ensureFields();
    if (!this.#isRecord(value)) {
      throwInvalidError([], value, this);
    }
    for (const field of this.#fields) {
      await this.#writeField(field, value, tap);
    }
  }
  async read(tap) {
    this.#ensureFields();
    const result = {};
    for (const field of this.#fields) {
      result[field.getName()] = await field.getType().read(tap);
    }
    return result;
  }
  async skip(tap) {
    this.#ensureFields();
    for (const field of this.#fields) {
      await field.getType().skip(tap);
    }
  }
  async toBuffer(value) {
    this.#ensureFields();
    if (!this.#isRecord(value)) {
      throwInvalidError([], value, this);
    }
    const buffers = [];
    for (const field of this.#fields) {
      buffers.push(await this.#getFieldBuffer(field, value));
    }
    const totalSize = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);
    const combined = new Uint8Array(totalSize);
    let offset = 0;
    for (const buf of buffers) {
      combined.set(buf, offset);
      offset += buf.byteLength;
    }
    return combined.buffer;
  }
  cloneFromValue(value) {
    this.#ensureFields();
    if (!this.#isRecord(value)) {
      throw new Error("Cannot clone non-record value.");
    }
    const recordValue = value;
    const result = {};
    for (const field of this.#fields) {
      this.#cloneField(field, recordValue, result);
    }
    return result;
  }
  compare(val1, val2) {
    this.#ensureFields();
    if (!this.#isRecord(val1) || !this.#isRecord(val2)) {
      throw new Error("Record comparison requires object values.");
    }
    for (const field of this.#fields) {
      const order = field.getOrder();
      if (order === "ignore") {
        continue;
      }
      const v1 = this.#getComparableValue(val1, field);
      const v2 = this.#getComparableValue(val2, field);
      let comparison = field.getType().compare(v1, v2);
      if (comparison !== 0) {
        if (order === "descending") {
          comparison = -comparison;
        }
        return comparison;
      }
    }
    return 0;
  }
  random() {
    this.#ensureFields();
    const result = {};
    for (const field of this.#fields) {
      result[field.getName()] = field.getType().random();
    }
    return result;
  }
  toJSON() {
    this.#ensureFields();
    const fieldsJson = this.#fields.map((field) => {
      const fieldJson = {
        name: field.getName(),
        type: field.getType().toJSON()
      };
      if (field.hasDefault()) {
        fieldJson.default = field.getDefault();
      }
      const aliases = field.getAliases();
      if (aliases.length > 0) {
        fieldJson.aliases = aliases;
      }
      if (field.getOrder() !== "ascending") {
        fieldJson.order = field.getOrder();
      }
      return fieldJson;
    });
    return {
      name: this.getFullName(),
      type: "record",
      fields: fieldsJson
    };
  }
  async match(tap1, tap2) {
    this.#ensureFields();
    for (const field of this.#fields) {
      const order = this.#getOrderValue(field.getOrder());
      const type = field.getType();
      if (order !== 0) {
        const result = await type.match(tap1, tap2) * order;
        if (result !== 0) {
          return result;
        }
      } else {
        await type.skip(tap1);
        await type.skip(tap2);
      }
    }
    return 0;
  }
  #ensureFields() {
    if (this.#fieldsThunk) {
      const builder = this.#fieldsThunk;
      this.#fieldsThunk = undefined;
      const resolved = builder();
      this.#setFields(resolved);
    }
  }
  #setFields(candidate) {
    if (!Array.isArray(candidate)) {
      throw new Error("RecordType requires a fields array.");
    }
    this.#fields = [];
    this.#fieldNameToIndex.clear();
    candidate.forEach((fieldParams) => {
      const field = new RecordField(fieldParams);
      if (this.#fieldNameToIndex.has(field.getName())) {
        throw new Error(`Duplicate record field name: ${field.getName()}`);
      }
      this.#fieldNameToIndex.set(field.getName(), this.#fields.length);
      this.#fields.push(field);
    });
  }
  #getOrderValue(order) {
    switch (order) {
      case "ascending":
        return 1;
      case "descending":
        return -1;
      case "ignore":
        return 0;
    }
  }
  createResolver(writerType) {
    this.#ensureFields();
    if (!(writerType instanceof RecordType)) {
      return super.createResolver(writerType);
    }
    const acceptableNames = new Set([
      this.getFullName(),
      ...this.getAliases()
    ]);
    if (!acceptableNames.has(writerType.getFullName())) {
      throw new Error(`Schema evolution not supported from writer type: ${writerType.getFullName()} to reader type: ${this.getFullName()}`);
    }
    const readerFields = this.#fields;
    const writerFields = writerType.getFields();
    const readerNameToIndex = new Map;
    readerFields.forEach((field, index) => {
      readerNameToIndex.set(field.getName(), index);
      field.getAliases().forEach((alias) => {
        readerNameToIndex.set(alias, index);
      });
    });
    const assignedReaderIndexes = new Set;
    const mappings = [];
    writerFields.forEach((writerField) => {
      let readerIndex = readerNameToIndex.get(writerField.getName());
      if (readerIndex === undefined) {
        for (const alias of writerField.getAliases()) {
          const idx = readerNameToIndex.get(alias);
          if (idx !== undefined) {
            readerIndex = idx;
            break;
          }
        }
      }
      if (readerIndex === undefined) {
        mappings.push({
          readerIndex: -1,
          writerField
        });
        return;
      }
      if (assignedReaderIndexes.has(readerIndex)) {
        throw new Error(`Multiple writer fields map to reader field: ${readerFields[readerIndex].getName()}`);
      }
      const readerField = readerFields[readerIndex];
      const readerType = readerField.getType();
      const writerType2 = writerField.getType();
      const resolver = readerType.constructor === writerType2.constructor ? undefined : readerType.createResolver(writerType2);
      mappings.push({
        readerIndex,
        writerField,
        resolver
      });
      assignedReaderIndexes.add(readerIndex);
    });
    readerFields.forEach((field, index) => {
      if (!assignedReaderIndexes.has(index) && !field.hasDefault()) {
        throw new Error(`Field '${field.getName()}' missing from writer schema and has no default.`);
      }
    });
    return new RecordResolver(this, mappings, readerFields);
  }
  #isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  #extractFieldValue(record, field) {
    const name = field.getName();
    const hasValue = Object.hasOwn(record, name);
    const fieldValue = hasValue ? record[name] : undefined;
    return {
      hasValue,
      fieldValue
    };
  }
  #checkField(field, record, errorHook, path) {
    const { hasValue, fieldValue } = this.#extractFieldValue(record, field);
    if (!hasValue) {
      if (!field.hasDefault()) {
        if (errorHook) {
          errorHook([
            ...path,
            field.getName()
          ], undefined, this);
        }
        return false;
      }
      return true;
    }
    const nextPath = errorHook ? [
      ...path,
      field.getName()
    ] : undefined;
    const valid = field.getType().check(fieldValue, errorHook, nextPath);
    return valid || errorHook !== undefined;
  }
  async#writeField(field, record, tap) {
    const { hasValue, fieldValue } = this.#extractFieldValue(record, field);
    let toWrite = fieldValue;
    if (!hasValue) {
      if (!field.hasDefault()) {
        throwInvalidError([
          field.getName()
        ], undefined, this);
      }
      toWrite = field.getDefault();
    }
    await field.getType().write(tap, toWrite);
  }
  async#getFieldBuffer(field, record) {
    const { hasValue, fieldValue } = this.#extractFieldValue(record, field);
    let toEncode = fieldValue;
    if (!hasValue) {
      if (!field.hasDefault()) {
        throwInvalidError([
          field.getName()
        ], undefined, this);
      }
      toEncode = field.getDefault();
    }
    return new Uint8Array(await field.getType().toBuffer(toEncode));
  }
  #cloneField(field, record, result) {
    const { hasValue, fieldValue } = this.#extractFieldValue(record, field);
    if (!hasValue) {
      if (!field.hasDefault()) {
        throw new Error(`Missing value for record field ${field.getName()} with no default.`);
      }
      result[field.getName()] = field.getDefault();
      return;
    }
    result[field.getName()] = field.getType().cloneFromValue(fieldValue);
  }
  #getComparableValue(record, field) {
    const { hasValue, fieldValue } = this.#extractFieldValue(record, field);
    if (hasValue) {
      return fieldValue;
    }
    if (field.hasDefault()) {
      return field.getDefault();
    }
    throw new Error(`Missing comparable value for field '${field.getName()}' with no default.`);
  }
}

class RecordResolver extends Resolver {
  #mappings;
  #readerFields;
  constructor(reader, mappings, readerFields) {
    super(reader);
    this.#mappings = mappings;
    this.#readerFields = readerFields;
  }
  async read(tap) {
    const result = {};
    const seen = new Array(this.#readerFields.length).fill(false);
    for (const mapping of this.#mappings) {
      if (mapping.readerIndex === -1) {
        await mapping.writerField.getType().skip(tap);
        continue;
      }
      const value = mapping.resolver ? await mapping.resolver.read(tap) : await mapping.writerField.getType().read(tap);
      const readerField = this.#readerFields[mapping.readerIndex];
      result[readerField.getName()] = value;
      seen[mapping.readerIndex] = true;
    }
    for (let i = 0;i < this.#readerFields.length; i++) {
      if (!seen[i]) {
        const field = this.#readerFields[i];
        result[field.getName()] = field.getDefault();
      }
    }
    return result;
  }
}

// node_modules/@sachitv/avro-typescript/src/schemas/primitive/string_type.js
class StringType extends PrimitiveType {
  check(value, errorHook, path = []) {
    const isValid = typeof value === "string";
    if (!isValid && errorHook) {
      errorHook(path, value, this);
    }
    return isValid;
  }
  async toBuffer(value) {
    this.check(value, throwInvalidError, []);
    const strBytes = encode(value);
    const lengthSize = calculateVarintSize(strBytes.length);
    const buf = new ArrayBuffer(lengthSize + strBytes.length);
    const tap = new WritableTap(buf);
    await this.write(tap, value);
    return buf;
  }
  async read(tap) {
    return await tap.readString();
  }
  async write(tap, value) {
    if (typeof value !== "string") {
      throwInvalidError([], value, this);
    }
    await tap.writeString(value);
  }
  async skip(tap) {
    await tap.skipString();
  }
  compare(val1, val2) {
    return val1 < val2 ? -1 : val1 > val2 ? 1 : 0;
  }
  random() {
    return Math.random().toString(36).substring(2, 10);
  }
  createResolver(writerType) {
    if (writerType.toJSON() === "bytes") {
      return new class extends Resolver {
        async read(tap) {
          const bytes = await tap.readBytes();
          return decode(bytes);
        }
      }(this);
    } else {
      return super.createResolver(writerType);
    }
  }
  toJSON() {
    return "string";
  }
  async match(tap1, tap2) {
    return await tap1.matchString(tap2);
  }
}

// node_modules/@sachitv/avro-typescript/src/schemas/complex/union_type.js
function isPlainObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function getBranchTypeName(type) {
  if (type instanceof NamedType) {
    return type.getFullName();
  }
  const schema = type.toJSON();
  if (typeof schema === "string") {
    return schema;
  }
  if (schema && typeof schema === "object") {
    const maybeType = schema.type;
    if (typeof maybeType === "string") {
      return maybeType;
    }
  }
  throw new Error("Unable to determine union branch name.");
}

class UnionType extends BaseType {
  #types;
  #branches;
  #indices;
  constructor(params) {
    super();
    const { types } = params;
    if (!Array.isArray(types)) {
      throw new Error("UnionType requires an array of branch types.");
    }
    if (types.length === 0) {
      throw new Error("UnionType requires at least one branch type.");
    }
    this.#types = [];
    this.#branches = [];
    this.#indices = new Map;
    types.forEach((type, index) => {
      if (!(type instanceof Type)) {
        throw new Error("UnionType branches must be Avro types.");
      }
      if (type instanceof UnionType) {
        throw new Error("Unions cannot be directly nested.");
      }
      const name = getBranchTypeName(type);
      if (this.#indices.has(name)) {
        throw new Error(`Duplicate union branch of type name: ${name}`);
      }
      const branch = {
        type,
        name,
        isNull: name === "null"
      };
      this.#types.push(type);
      this.#branches.push(branch);
      this.#indices.set(name, index);
    });
  }
  getTypes() {
    return this.#types.slice();
  }
  check(value, errorHook, path = []) {
    if (value === null) {
      const hasNull = this.#indices.has("null");
      if (!hasNull && errorHook) {
        errorHook(path.slice(), value, this);
      }
      return hasNull;
    }
    if (!isPlainObject2(value)) {
      if (errorHook) {
        errorHook(path.slice(), value, this);
      }
      return false;
    }
    const keys = Object.keys(value);
    if (keys.length !== 1) {
      if (errorHook) {
        errorHook(path.slice(), value, this);
      }
      return false;
    }
    const key = keys[0];
    if (key === "null") {
      if (errorHook) {
        errorHook(path.slice(), value, this);
      }
      return false;
    }
    const branchIndex = this.#indices.get(key);
    if (branchIndex === undefined) {
      if (errorHook) {
        errorHook(path.slice(), value, this);
      }
      return false;
    }
    const branch = this.#branches[branchIndex];
    const branchValue = value[key];
    const branchPath = errorHook ? [
      ...path,
      key
    ] : undefined;
    const isValid = branch.type.check(branchValue, errorHook, branchPath);
    if (!isValid && errorHook) {
      return false;
    }
    return isValid;
  }
  async write(tap, value) {
    const { index, branchValue } = this.#resolveBranch(value);
    await tap.writeLong(BigInt(index));
    if (branchValue !== undefined) {
      await this.#branches[index].type.write(tap, branchValue);
    }
  }
  async read(tap) {
    const index = await this.#readBranchIndex(tap);
    const branch = this.#branches[index];
    if (branch.isNull) {
      return null;
    }
    const branchValue = await branch.type.read(tap);
    return {
      [branch.name]: branchValue
    };
  }
  async skip(tap) {
    const index = await this.#readBranchIndex(tap);
    const branch = this.#branches[index];
    if (!branch.isNull) {
      await branch.type.skip(tap);
    }
  }
  async toBuffer(value) {
    const { index, branchValue } = this.#resolveBranch(value);
    const indexSize = calculateVarintSize(index);
    let totalSize = indexSize;
    let branchBytes;
    if (branchValue !== undefined) {
      branchBytes = new Uint8Array(await this.#branches[index].type.toBuffer(branchValue));
      totalSize += branchBytes.byteLength;
    }
    const buffer = new ArrayBuffer(totalSize);
    const tap = new WritableTap(buffer);
    await tap.writeLong(BigInt(index));
    if (branchBytes) {
      await tap.writeFixed(branchBytes);
    }
    return buffer;
  }
  cloneFromValue(value) {
    if (value === null) {
      if (!this.#indices.has("null")) {
        throw new Error("Cannot clone null for a union without null branch.");
      }
      return null;
    }
    const { index, branchValue } = this.#resolveBranch(value);
    if (branchValue === undefined) {
      return null;
    }
    const cloned = this.#branches[index].type.cloneFromValue(branchValue);
    return {
      [this.#branches[index].name]: cloned
    };
  }
  compare(val1, val2) {
    const branch1 = this.#resolveBranch(val1);
    const branch2 = this.#resolveBranch(val2);
    if (branch1.index === branch2.index) {
      if (branch1.branchValue === undefined) {
        return 0;
      }
      return this.#branches[branch1.index].type.compare(branch1.branchValue, branch2.branchValue);
    }
    return branch1.index < branch2.index ? -1 : 1;
  }
  random() {
    const index = Math.floor(Math.random() * this.#branches.length);
    const branch = this.#branches[index];
    if (branch.isNull) {
      return null;
    }
    const value = branch.type.random();
    return {
      [branch.name]: value
    };
  }
  toJSON() {
    return this.#types.map((type) => type.toJSON());
  }
  async match(tap1, tap2) {
    const idx1 = await this.#readBranchIndex(tap1);
    const idx2 = await this.#readBranchIndex(tap2);
    if (idx1 === idx2) {
      const branch = this.#branches[idx1];
      if (branch.isNull) {
        return 0;
      }
      return await branch.type.match(tap1, tap2);
    }
    return idx1 < idx2 ? -1 : 1;
  }
  createResolver(writerType) {
    if (writerType instanceof UnionType) {
      const branchResolvers = writerType.getTypes().map((branch) => this.createResolver(branch));
      return new UnionFromUnionResolver(this, branchResolvers);
    }
    for (let i = 0;i < this.#branches.length; i++) {
      const branch = this.#branches[i];
      try {
        const resolver = branch.type.createResolver(writerType);
        return new UnionBranchResolver(this, branch, resolver);
      } catch {}
    }
    return super.createResolver(writerType);
  }
  #resolveBranch(value) {
    if (value === null) {
      const index = this.#indices.get("null");
      if (index === undefined) {
        throwInvalidError([], value, this);
      }
      return {
        index,
        branchValue: undefined
      };
    }
    if (!isPlainObject2(value)) {
      throwInvalidError([], value, this);
    }
    const keys = Object.keys(value);
    if (keys.length !== 1) {
      throwInvalidError([], value, this);
    }
    const key = keys[0];
    const branchIndex = this.#indices.get(key);
    if (branchIndex === undefined) {
      throwInvalidError([], value, this);
    }
    const branch = this.#branches[branchIndex];
    const branchValue = value[key];
    if (!branch.isNull && branchValue === undefined) {
      throwInvalidError([], value, this);
    }
    if (branch.isNull && branchValue !== undefined) {
      throwInvalidError([], value, this);
    }
    return {
      index: branchIndex,
      branchValue
    };
  }
  async#readBranchIndex(tap) {
    const indexBigInt = await tap.readLong();
    const index = bigIntToSafeNumber(indexBigInt, "Union branch index");
    if (index < 0 || index >= this.#branches.length) {
      throw new Error(`Invalid union index: ${index}`);
    }
    return index;
  }
}

class UnionBranchResolver extends Resolver {
  #branch;
  #branchResolver;
  constructor(reader, branch, branchResolver) {
    super(reader);
    this.#branch = branch;
    this.#branchResolver = branchResolver;
  }
  async read(tap) {
    const resolvedValue = await this.#branchResolver.read(tap);
    if (this.#branch.isNull) {
      return null;
    }
    return {
      [this.#branch.name]: resolvedValue
    };
  }
}

class UnionFromUnionResolver extends Resolver {
  #resolvers;
  constructor(reader, resolvers) {
    super(reader);
    this.#resolvers = resolvers;
  }
  async read(tap) {
    const indexBigInt = await tap.readLong();
    const index = bigIntToSafeNumber(indexBigInt, "Union branch index");
    const resolver = this.#resolvers[index];
    if (!resolver) {
      throw new Error(`Invalid union index: ${index}`);
    }
    return await resolver.read(tap);
  }
}

// node_modules/@sachitv/avro-typescript/src/schemas/primitive/null_type.js
class NullType extends FixedSizeBaseType {
  check(value, errorHook, path = []) {
    const isValid = value === null;
    if (!isValid && errorHook) {
      errorHook(path, value, this);
    }
    return isValid;
  }
  async read(_tap) {
    return await Promise.resolve(null);
  }
  async write(_tap, value) {
    if (value !== null) {
      throwInvalidError([], value, this);
    }
    await Promise.resolve();
  }
  async skip(_tap) {}
  sizeBytes() {
    return 0;
  }
  cloneFromValue(value) {
    this.check(value, throwInvalidError, []);
    return value;
  }
  compare(_val1, _val2) {
    return 0;
  }
  random() {
    return null;
  }
  toJSON() {
    return "null";
  }
  async match(_tap1, _tap2) {
    return await Promise.resolve(0);
  }
}

// node_modules/@sachitv/avro-typescript/src/schemas/logical/logical_type.js
class LogicalType extends Type {
  underlyingType;
  constructor(underlyingType) {
    super();
    this.underlyingType = underlyingType;
  }
  getUnderlyingType() {
    return this.underlyingType;
  }
  convertFromUnderlying(value) {
    return this.fromUnderlying(value);
  }
  canReadFromLogical(_writer) {
    return _writer.constructor === this.constructor;
  }
  async toBuffer(value) {
    this.ensureValid(value, []);
    const underlying = this.toUnderlying(value);
    return await this.underlyingType.toBuffer(underlying);
  }
  async fromBuffer(buffer) {
    const underlying = await this.underlyingType.fromBuffer(buffer);
    return this.fromUnderlying(underlying);
  }
  isValid(value, opts) {
    return this.check(value, opts?.errorHook, []);
  }
  check(value, errorHook, path = []) {
    if (!this.isInstance(value)) {
      if (errorHook) {
        errorHook(path.slice(), value, this);
      }
      return false;
    }
    let underlying;
    try {
      underlying = this.toUnderlying(value);
    } catch {
      if (errorHook) {
        errorHook(path.slice(), value, this);
      }
      return false;
    }
    return this.underlyingType.check(underlying, errorHook, path);
  }
  cloneFromValue(value) {
    this.check(value, throwInvalidError, []);
    const typedValue = value;
    const cloned = this.underlyingType.cloneFromValue(this.toUnderlying(typedValue));
    return this.fromUnderlying(cloned);
  }
  compare(val1, val2) {
    const u1 = this.toUnderlying(val1);
    const u2 = this.toUnderlying(val2);
    return this.underlyingType.compare(u1, u2);
  }
  random() {
    const underlying = this.underlyingType.random();
    return this.fromUnderlying(underlying);
  }
  async write(tap, value) {
    this.ensureValid(value, []);
    await this.underlyingType.write(tap, this.toUnderlying(value));
  }
  async read(tap) {
    const underlying = await this.underlyingType.read(tap);
    return this.fromUnderlying(underlying);
  }
  async skip(tap) {
    await this.underlyingType.skip(tap);
  }
  async match(tap1, tap2) {
    return await this.underlyingType.match(tap1, tap2);
  }
  createResolver(writerType) {
    if (writerType instanceof LogicalType) {
      if (!this.canReadFromLogical(writerType)) {
        throw new Error("Schema evolution not supported between incompatible logical types.");
      }
      const resolver2 = this.underlyingType.createResolver(writerType.getUnderlyingType());
      return new LogicalResolver(this, resolver2);
    }
    const resolver = this.underlyingType.createResolver(writerType);
    return new LogicalResolver(this, resolver);
  }
  ensureValid(value, path) {
    this.check(value, throwInvalidError, path);
  }
}

class LogicalResolver extends Resolver {
  #logicalType;
  #resolver;
  constructor(logicalType, resolver) {
    super(logicalType);
    this.#logicalType = logicalType;
    this.#resolver = resolver;
  }
  async read(tap) {
    const underlying = await this.#resolver.read(tap);
    return this.#logicalType.convertFromUnderlying(underlying);
  }
}

class NamedLogicalType extends LogicalType {
  namedType;
  constructor(namedType) {
    super(namedType);
    this.namedType = namedType;
  }
  getFullName() {
    return this.namedType.getFullName();
  }
  getNamespace() {
    return this.namedType.getNamespace();
  }
  getAliases() {
    return this.namedType.getAliases();
  }
}
function withLogicalTypeJSON(underlying, logicalType, extras = {}) {
  if (typeof underlying === "string") {
    return {
      type: underlying,
      logicalType,
      ...extras
    };
  }
  if (underlying && typeof underlying === "object" && !Array.isArray(underlying)) {
    return {
      ...underlying,
      logicalType,
      ...extras
    };
  }
  throw new Error("Unsupported underlying schema for logical type serialization.");
}

// node_modules/@sachitv/avro-typescript/src/schemas/logical/decimal_logical_type.js
class DecimalLogicalType extends LogicalType {
  #precision;
  #scale;
  #fixedSize;
  constructor(underlying, params) {
    super(underlying);
    if (!(underlying instanceof BytesType || underlying instanceof FixedType)) {
      throw new Error("Decimal logical type requires bytes or fixed underlying type.");
    }
    const precision = params.precision;
    if (!Number.isInteger(precision) || precision <= 0) {
      throw new Error("Decimal logical type requires a positive precision.");
    }
    const scale = params.scale ?? 0;
    if (!Number.isInteger(scale) || scale < 0 || scale > precision) {
      throw new Error("Decimal logical type requires a valid scale (0 <= scale <= precision).");
    }
    if (underlying instanceof FixedType) {
      const size = underlying.getSize();
      const maxPrecision = Math.floor(Math.log10(2) * (8 * size - 1));
      if (precision > maxPrecision) {
        throw new Error("Decimal precision exceeds maximum for fixed size.");
      }
      this.#fixedSize = size;
    }
    this.#precision = precision;
    this.#scale = scale;
  }
  getPrecision() {
    return this.#precision;
  }
  getScale() {
    return this.#scale;
  }
  canReadFromLogical(writer) {
    return writer instanceof DecimalLogicalType && writer.#precision === this.#precision && writer.#scale === this.#scale;
  }
  isInstance(value) {
    return typeof value === "bigint";
  }
  toUnderlying(value) {
    const digits = value < 0n ? (-value).toString().length : value.toString().length;
    if (digits > this.#precision) {
      throw new Error(`Decimal value: ${value} exceeds declared precision: ${this.#precision}`);
    }
    const size = this.#fixedSize;
    const byteLength = size ?? minimalBytesForValue(value);
    return encodeBigInt(value, byteLength);
  }
  fromUnderlying(value) {
    return decodeBigInt(value);
  }
  toJSON() {
    const extras = {
      precision: this.#precision
    };
    if (this.#scale !== 0) {
      extras.scale = this.#scale;
    }
    return withLogicalTypeJSON(this.getUnderlyingType().toJSON(), "decimal", extras);
  }
}
function minimalBytesForValue(value) {
  let bytes = 1;
  while (value < -(1n << BigInt(bytes * 8 - 1)) || value >= 1n << BigInt(bytes * 8 - 1)) {
    bytes++;
  }
  return bytes;
}
function encodeBigInt(value, size) {
  let twos = BigInt.asUintN(size * 8, value);
  const result = new Uint8Array(size);
  for (let i = size - 1;i >= 0; i--) {
    result[i] = Number(twos & 0xffn);
    twos >>= 8n;
  }
  return result;
}
function decodeBigInt(bytes) {
  if (bytes.length === 0) {
    return 0n;
  }
  let value = 0n;
  for (const byte of bytes) {
    value = value << 8n | BigInt(byte);
  }
  if (bytes[0] & 128) {
    const max = 1n << BigInt(bytes.length * 8);
    value -= max;
  }
  return value;
}

// node_modules/@sachitv/avro-typescript/src/schemas/logical/uuid_logical_type.js
var UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

class UuidLogicalType extends LogicalType {
  #underlying;
  #named;
  constructor(underlying) {
    super(underlying);
    this.#underlying = underlying;
    if (underlying instanceof FixedType) {
      if (underlying.getSize() !== 16) {
        throw new Error("UUID logical type requires fixed size of 16 bytes.");
      }
      this.#named = underlying;
    }
  }
  canReadFromLogical(writer) {
    return writer instanceof UuidLogicalType;
  }
  isInstance(value) {
    return typeof value === "string" && UUID_REGEX.test(value);
  }
  toUnderlying(value) {
    if (this.#underlying instanceof StringType) {
      return value;
    }
    return uuidToBytes(value);
  }
  fromUnderlying(value) {
    if (typeof value === "string") {
      return value;
    }
    return bytesToUuid(value);
  }
  random() {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    for (let i = 0;i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = bytes[6] & 15 | 64;
    bytes[8] = bytes[8] & 63 | 128;
    return bytesToUuid(bytes);
  }
  toJSON() {
    return withLogicalTypeJSON(this.#underlying.toJSON(), "uuid");
  }
  getFullName() {
    if (!this.#named) {
      throw new Error("UUID logical type backed by string has no name.");
    }
    return this.#named.getFullName();
  }
  getNamespace() {
    if (!this.#named) {
      throw new Error("UUID logical type backed by string has no namespace.");
    }
    return this.#named.getNamespace();
  }
  getAliases() {
    if (!this.#named) {
      throw new Error("UUID logical type backed by string has no aliases.");
    }
    return this.#named.getAliases();
  }
}
function uuidToBytes(value) {
  const hex = value.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0;i < 16; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
function bytesToUuid(bytes) {
  if (bytes.length !== 16) {
    throw new Error("UUID bytes must be 16 bytes long.");
  }
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// node_modules/@sachitv/avro-typescript/src/schemas/logical/temporal_logical_types.js
var MILLIS_PER_DAY = 86400000;
var MICROS_PER_DAY = 86400000000n;

class DateLogicalType extends LogicalType {
  constructor(underlying) {
    super(underlying);
  }
  canReadFromLogical(writer) {
    return writer instanceof DateLogicalType;
  }
  isInstance(value) {
    return typeof value === "number" && Number.isInteger(value);
  }
  toUnderlying(value) {
    return value;
  }
  fromUnderlying(value) {
    return value;
  }
  random() {
    const today = Math.floor(Date.now() / MILLIS_PER_DAY);
    return today + Math.floor(Math.random() * 2000) - 1000;
  }
  toJSON() {
    return withLogicalTypeJSON(this.getUnderlyingType().toJSON(), "date");
  }
}

class TimeMillisLogicalType extends LogicalType {
  constructor(underlying) {
    super(underlying);
  }
  canReadFromLogical(writer) {
    return writer instanceof TimeMillisLogicalType;
  }
  isInstance(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < MILLIS_PER_DAY;
  }
  toUnderlying(value) {
    return value;
  }
  fromUnderlying(value) {
    return value;
  }
  random() {
    return Math.floor(Math.random() * MILLIS_PER_DAY);
  }
  toJSON() {
    return withLogicalTypeJSON(this.getUnderlyingType().toJSON(), "time-millis");
  }
}

class TimeMicrosLogicalType extends LogicalType {
  constructor(underlying) {
    super(underlying);
  }
  canReadFromLogical(writer) {
    return writer instanceof TimeMicrosLogicalType;
  }
  isInstance(value) {
    return typeof value === "bigint" && value >= 0n && value < MICROS_PER_DAY;
  }
  toUnderlying(value) {
    return value;
  }
  fromUnderlying(value) {
    return value;
  }
  random() {
    return BigInt(Math.floor(Math.random() * Number(MICROS_PER_DAY)));
  }
  toJSON() {
    return withLogicalTypeJSON(this.getUnderlyingType().toJSON(), "time-micros");
  }
}

class TimestampMillisLogicalType extends LogicalType {
  constructor(underlying) {
    super(underlying);
  }
  canReadFromLogical(writer) {
    return writer instanceof TimestampMillisLogicalType;
  }
  isInstance(value) {
    return value instanceof Date && !Number.isNaN(value.getTime());
  }
  toUnderlying(value) {
    const millis = value.getTime();
    if (!Number.isFinite(millis)) {
      throw new Error("Invalid Date value for timestamp-millis logical type.");
    }
    return BigInt(Math.trunc(millis));
  }
  fromUnderlying(value) {
    const millis = bigIntToSafeNumber(value, "timestamp-millis");
    return new Date(millis);
  }
  random() {
    const now = Date.now();
    const offset = Math.floor(Math.random() * 1e9) - 500000000;
    return new Date(now + offset);
  }
  compare(val1, val2) {
    const diff = val1.getTime() - val2.getTime();
    return diff < 0 ? -1 : diff > 0 ? 1 : 0;
  }
  toJSON() {
    return withLogicalTypeJSON(this.getUnderlyingType().toJSON(), "timestamp-millis");
  }
}

class TimestampMicrosLogicalType extends LogicalType {
  constructor(underlying) {
    super(underlying);
  }
  canReadFromLogical(writer) {
    return writer instanceof TimestampMicrosLogicalType;
  }
  isInstance(value) {
    return typeof value === "bigint";
  }
  toUnderlying(value) {
    return value;
  }
  fromUnderlying(value) {
    return value;
  }
  random() {
    const nowMicros = BigInt(Math.trunc(Date.now())) * 1000n;
    const offset = BigInt(Math.floor(Math.random() * 1e6)) - 500000n;
    return nowMicros + offset;
  }
  toJSON() {
    return withLogicalTypeJSON(this.getUnderlyingType().toJSON(), "timestamp-micros");
  }
}

class TimestampNanosLogicalType extends LogicalType {
  constructor(underlying) {
    super(underlying);
  }
  canReadFromLogical(writer) {
    return writer instanceof TimestampNanosLogicalType;
  }
  isInstance(value) {
    return typeof value === "bigint";
  }
  toUnderlying(value) {
    return value;
  }
  fromUnderlying(value) {
    return value;
  }
  random() {
    const nowNanos = BigInt(Math.trunc(Date.now())) * 1000000n;
    const offset = BigInt(Math.floor(Math.random() * 1e6)) - 500000n;
    return nowNanos + offset;
  }
  toJSON() {
    return withLogicalTypeJSON(this.getUnderlyingType().toJSON(), "timestamp-nanos");
  }
}

class LocalTimestampMillisLogicalType extends LogicalType {
  constructor(underlying) {
    super(underlying);
  }
  canReadFromLogical(writer) {
    return writer instanceof LocalTimestampMillisLogicalType;
  }
  isInstance(value) {
    return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
  }
  toUnderlying(value) {
    return BigInt(value);
  }
  fromUnderlying(value) {
    return bigIntToSafeNumber(value, "local-timestamp-millis");
  }
  random() {
    const now = Date.now();
    const offset = Math.floor(Math.random() * 1e9) - 500000000;
    return Math.trunc(now + offset);
  }
  toJSON() {
    return withLogicalTypeJSON(this.getUnderlyingType().toJSON(), "local-timestamp-millis");
  }
}

class LocalTimestampMicrosLogicalType extends LogicalType {
  constructor(underlying) {
    super(underlying);
  }
  canReadFromLogical(writer) {
    return writer instanceof LocalTimestampMicrosLogicalType;
  }
  isInstance(value) {
    return typeof value === "bigint";
  }
  toUnderlying(value) {
    return value;
  }
  fromUnderlying(value) {
    return value;
  }
  random() {
    const nowMicros = BigInt(Math.trunc(Date.now())) * 1000n;
    const offset = BigInt(Math.floor(Math.random() * 1e6)) - 500000n;
    return nowMicros + offset;
  }
  toJSON() {
    return withLogicalTypeJSON(this.getUnderlyingType().toJSON(), "local-timestamp-micros");
  }
}

class LocalTimestampNanosLogicalType extends LogicalType {
  constructor(underlying) {
    super(underlying);
  }
  canReadFromLogical(writer) {
    return writer instanceof LocalTimestampNanosLogicalType;
  }
  isInstance(value) {
    return typeof value === "bigint";
  }
  toUnderlying(value) {
    return value;
  }
  fromUnderlying(value) {
    return value;
  }
  random() {
    const nowNanos = BigInt(Math.trunc(Date.now())) * 1000000n;
    const offset = BigInt(Math.floor(Math.random() * 1e6)) - 500000n;
    return nowNanos + offset;
  }
  toJSON() {
    return withLogicalTypeJSON(this.getUnderlyingType().toJSON(), "local-timestamp-nanos");
  }
}

// node_modules/@sachitv/avro-typescript/src/schemas/logical/duration_logical_type.js
var MAX_UINT32 = 4294967295;

class DurationLogicalType extends NamedLogicalType {
  constructor(underlying) {
    super(underlying);
    if (underlying.getSize() !== 12) {
      throw new Error("Duration logical type requires fixed size of 12 bytes.");
    }
  }
  canReadFromLogical(writer) {
    return writer instanceof DurationLogicalType;
  }
  isInstance(value) {
    return isDurationValue(value);
  }
  toUnderlying(value) {
    const buffer = new ArrayBuffer(12);
    const view = new DataView(buffer);
    view.setUint32(0, value.months, true);
    view.setUint32(4, value.days, true);
    view.setUint32(8, value.millis, true);
    return new Uint8Array(buffer);
  }
  fromUnderlying(value) {
    if (value.length !== 12) {
      throw new Error("Duration bytes must be 12 bytes long.");
    }
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    return {
      months: view.getUint32(0, true),
      days: view.getUint32(4, true),
      millis: view.getUint32(8, true)
    };
  }
  compare(a, b) {
    if (a.months !== b.months) {
      return a.months < b.months ? -1 : 1;
    }
    if (a.days !== b.days) {
      return a.days < b.days ? -1 : 1;
    }
    if (a.millis !== b.millis) {
      return a.millis < b.millis ? -1 : 1;
    }
    return 0;
  }
  random() {
    return {
      months: Math.floor(Math.random() * 1200),
      days: Math.floor(Math.random() * 365),
      millis: Math.floor(Math.random() * 86400000)
    };
  }
  toJSON() {
    return withLogicalTypeJSON(this.getUnderlyingType().toJSON(), "duration");
  }
}
function isDurationValue(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const maybe = value;
  return isUint32(maybe.months) && isUint32(maybe.days) && isUint32(maybe.millis);
}
function isUint32(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_UINT32;
}

// node_modules/@sachitv/avro-typescript/src/type/create_type.js
var PRIMITIVE_FACTORIES = {
  null: () => new NullType,
  boolean: () => new BooleanType,
  int: () => new IntType,
  long: () => new LongType,
  float: () => new FloatType,
  double: () => new DoubleType,
  bytes: () => new BytesType,
  string: () => new StringType
};
function createType(schema, options = {}) {
  const registry = options.registry ?? new Map;
  const context = {
    namespace: options.namespace,
    registry
  };
  return constructType(schema, context);
}
function constructType(schema, context) {
  if (schema instanceof Type) {
    return schema;
  }
  if (typeof schema === "string") {
    return createFromTypeName(schema, context);
  }
  if (Array.isArray(schema)) {
    return createUnionType(schema, context);
  }
  if (schema === null || typeof schema !== "object") {
    throw new Error(`Unsupported Avro schema: ${safeStringify(schema)}`);
  }
  const logicalType = schema.logicalType;
  if (logicalType !== undefined) {
    return createLogicalType(schema, logicalType, context);
  }
  const { type } = schema;
  if (typeof type === "string") {
    if (isRecordTypeName(type)) {
      return createRecordType(schema, type, context);
    }
    if (type === "enum") {
      return createEnumType(schema, context);
    }
    if (type === "fixed") {
      return createFixedType(schema, context);
    }
    if (type === "array") {
      return createArrayType(schema, context);
    }
    if (type === "map") {
      return createMapType(schema, context);
    }
    if (isPrimitiveTypeName(type)) {
      return PRIMITIVE_FACTORIES[type]();
    }
    return createFromTypeName(type, {
      namespace: extractNamespace(schema, context.namespace),
      registry: context.registry
    });
  }
  if (Array.isArray(type)) {
    return createUnionType(type, context);
  }
  if (type && typeof type === "object") {
    return constructType(type, context);
  }
  throw new Error(`Schema is missing a valid "type" property: ${safeStringify(schema)}`);
}
function createLogicalType(schema, logicalType, context) {
  const buildUnderlying = () => {
    const underlyingSchema = {
      ...schema
    };
    delete underlyingSchema.logicalType;
    return constructType(underlyingSchema, context);
  };
  if (typeof logicalType !== "string") {
    return buildUnderlying();
  }
  const underlying = buildUnderlying();
  const replaceIfNamed = (logical) => {
    if (underlying instanceof NamedType) {
      context.registry.set(underlying.getFullName(), logical);
    }
    return logical;
  };
  try {
    switch (logicalType) {
      case "decimal": {
        if (underlying instanceof BytesType || underlying instanceof FixedType) {
          const precision = schema.precision;
          const scaleValue = schema.scale;
          if (typeof precision !== "number") {
            return underlying;
          }
          if (scaleValue !== undefined && typeof scaleValue !== "number") {
            return underlying;
          }
          const logical = new DecimalLogicalType(underlying, {
            precision,
            scale: scaleValue
          });
          return replaceIfNamed(logical);
        }
        return underlying;
      }
      case "uuid": {
        if (underlying instanceof StringType || underlying instanceof FixedType) {
          const logical = new UuidLogicalType(underlying);
          return replaceIfNamed(logical);
        }
        return underlying;
      }
      case "date": {
        if (underlying instanceof IntType) {
          return new DateLogicalType(underlying);
        }
        return underlying;
      }
      case "time-millis": {
        if (underlying instanceof IntType) {
          return new TimeMillisLogicalType(underlying);
        }
        return underlying;
      }
      case "time-micros": {
        if (underlying instanceof LongType) {
          return new TimeMicrosLogicalType(underlying);
        }
        return underlying;
      }
      case "timestamp-millis": {
        if (underlying instanceof LongType) {
          return new TimestampMillisLogicalType(underlying);
        }
        return underlying;
      }
      case "timestamp-micros": {
        if (underlying instanceof LongType) {
          return new TimestampMicrosLogicalType(underlying);
        }
        return underlying;
      }
      case "timestamp-nanos": {
        if (underlying instanceof LongType) {
          return new TimestampNanosLogicalType(underlying);
        }
        return underlying;
      }
      case "local-timestamp-millis": {
        if (underlying instanceof LongType) {
          return new LocalTimestampMillisLogicalType(underlying);
        }
        return underlying;
      }
      case "local-timestamp-micros": {
        if (underlying instanceof LongType) {
          return new LocalTimestampMicrosLogicalType(underlying);
        }
        return underlying;
      }
      case "local-timestamp-nanos": {
        if (underlying instanceof LongType) {
          return new LocalTimestampNanosLogicalType(underlying);
        }
        return underlying;
      }
      case "duration": {
        if (underlying instanceof FixedType) {
          const logical = new DurationLogicalType(underlying);
          return replaceIfNamed(logical);
        }
        return underlying;
      }
      default:
        return underlying;
    }
  } catch {
    return underlying;
  }
}
function createFromTypeName(name, context) {
  if (isPrimitiveTypeName(name)) {
    return PRIMITIVE_FACTORIES[name]();
  }
  const fullName = qualifyReference(name, context.namespace);
  const found = context.registry.get(fullName);
  if (!found) {
    throw new Error(`Undefined Avro type reference: ${name}`);
  }
  return found;
}
function createRecordType(schema, typeName, context) {
  const name = schema.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`Record schema requires a non-empty name: ${safeStringify(schema)}`);
  }
  const aliases = toStringArray(schema.aliases);
  const resolved = resolveNames({
    name,
    namespace: extractNamespace(schema, context.namespace),
    aliases
  });
  const childContext = {
    namespace: resolved.namespace || undefined,
    registry: context.registry
  };
  const fieldsValue = schema.fields;
  if (!Array.isArray(fieldsValue)) {
    throw new Error(`Record schema requires a fields array: ${safeStringify(schema)}`);
  }
  const buildFields = () => {
    return fieldsValue.map((field) => {
      if (field === null || typeof field !== "object") {
        throw new Error(`Invalid record field definition: ${safeStringify(field)}`);
      }
      const fieldName = field.name;
      if (typeof fieldName !== "string" || fieldName.length === 0) {
        throw new Error(`Record field requires a non-empty name: ${safeStringify(field)}`);
      }
      if (!("type" in field)) {
        throw new Error(`Record field "${fieldName}" is missing a type definition.`);
      }
      const fieldType = constructType(field.type, childContext);
      const fieldAliases = toStringArray(field.aliases);
      const order = field.order;
      const fieldParams = {
        name: fieldName,
        type: fieldType
      };
      if (fieldAliases.length > 0) {
        fieldParams.aliases = fieldAliases;
      }
      if (order === "ascending" || order === "descending" || order === "ignore") {
        fieldParams.order = order;
      }
      if (field.default !== undefined) {
        fieldParams.default = field.default;
      }
      return fieldParams;
    });
  };
  const shouldRegister = typeName !== "request";
  if (shouldRegister && context.registry.has(resolved.fullName)) {
    throw new Error(`Duplicate Avro type name: ${resolved.fullName}`);
  }
  const params = {
    ...resolved,
    fields: buildFields
  };
  const record = new RecordType(params);
  if (shouldRegister) {
    context.registry.set(resolved.fullName, record);
  }
  return record;
}
function createEnumType(schema, context) {
  const name = schema.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`Enum schema requires a non-empty name: ${safeStringify(schema)}`);
  }
  const aliases = toStringArray(schema.aliases);
  const resolved = resolveNames({
    name,
    namespace: extractNamespace(schema, context.namespace),
    aliases
  });
  const symbols = schema.symbols;
  if (!Array.isArray(symbols) || symbols.some((s) => typeof s !== "string")) {
    throw new Error(`Enum schema requires an array of string symbols: ${safeStringify(schema)}`);
  }
  if (context.registry.has(resolved.fullName)) {
    throw new Error(`Duplicate Avro type name: ${resolved.fullName}`);
  }
  const params = {
    ...resolved,
    symbols: symbols.slice()
  };
  if (schema.default !== undefined) {
    params.default = schema.default;
  }
  const enumType = new EnumType(params);
  context.registry.set(resolved.fullName, enumType);
  return enumType;
}
function createFixedType(schema, context) {
  const name = schema.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`Fixed schema requires a non-empty name: ${safeStringify(schema)}`);
  }
  const aliases = toStringArray(schema.aliases);
  const resolved = resolveNames({
    name,
    namespace: extractNamespace(schema, context.namespace),
    aliases
  });
  if (context.registry.has(resolved.fullName)) {
    throw new Error(`Duplicate Avro type name: ${resolved.fullName}`);
  }
  const params = {
    ...resolved,
    size: schema.size
  };
  const fixed = new FixedType(params);
  context.registry.set(resolved.fullName, fixed);
  return fixed;
}
function createArrayType(schema, context) {
  if (!("items" in schema)) {
    throw new Error(`Array schema requires an "items" definition: ${safeStringify(schema)}`);
  }
  const itemsType = constructType(schema.items, context);
  return new ArrayType({
    items: itemsType
  });
}
function createMapType(schema, context) {
  if (!("values" in schema)) {
    throw new Error(`Map schema requires a "values" definition: ${safeStringify(schema)}`);
  }
  const valuesType = constructType(schema.values, context);
  return new MapType({
    values: valuesType
  });
}
function createUnionType(schemas, context) {
  if (schemas.length === 0) {
    throw new Error("Union schema requires at least one branch type.");
  }
  const types = schemas.map((branch) => constructType(branch, context));
  return new UnionType({
    types
  });
}
function isPrimitiveTypeName(value) {
  return typeof value === "string" && value in PRIMITIVE_FACTORIES;
}
function isRecordTypeName(value) {
  return value === "record" || value === "error" || value === "request";
}
function toStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry) => typeof entry === "string");
}
function extractNamespace(schema, fallback) {
  const namespace = schema.namespace;
  if (typeof namespace === "string") {
    return namespace.length > 0 ? namespace : undefined;
  }
  return fallback;
}
function qualifyReference(name, namespace) {
  if (!namespace || name.includes(".")) {
    return name;
  }
  return `${namespace}.${name}`;
}

// node_modules/@sachitv/avro-typescript/src/serialization/decoders/deflate_decoder.js
class DeflateDecoder {
  async decode(compressedData) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("Deflate codec not supported in this environment. DecompressionStream API required.");
    }
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(compressedData);
        controller.close();
      }
    });
    const decompressed = await new Response(stream.pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
    return new Uint8Array(decompressed);
  }
}

// node_modules/@sachitv/avro-typescript/src/serialization/decoders/null_decoder.js
class NullDecoder {
  decode(compressedData) {
    return Promise.resolve(compressedData);
  }
}

// node_modules/@sachitv/avro-typescript/src/serialization/avro_constants.js
var HEADER_TYPE = createType({
  type: "record",
  name: "org.apache.avro.file.Header",
  fields: [
    {
      name: "magic",
      type: {
        type: "fixed",
        name: "Magic",
        size: 4
      }
    },
    {
      name: "meta",
      type: {
        type: "map",
        values: "bytes"
      }
    },
    {
      name: "sync",
      type: {
        type: "fixed",
        name: "Sync",
        size: 16
      }
    }
  ]
});
var BLOCK_TYPE = createType({
  type: "record",
  name: "org.apache.avro.file.Block",
  fields: [
    {
      name: "count",
      type: "long"
    },
    {
      name: "data",
      type: "bytes"
    },
    {
      name: "sync",
      type: {
        type: "fixed",
        name: "Sync",
        size: 16
      }
    }
  ]
});
var MAGIC_BYTES = new Uint8Array([
  79,
  98,
  106,
  1
]);

// node_modules/@sachitv/avro-typescript/src/serialization/avro_file_parser.js
class AvroFileParser {
  #buffer;
  #header;
  #headerTap;
  #readerSchema;
  #readerType;
  #resolver;
  #decoders;
  #builtInDecoders;
  constructor(buffer, options) {
    this.#buffer = buffer;
    this.#readerSchema = options?.readerSchema;
    this.#builtInDecoders = {
      null: new NullDecoder,
      deflate: new DeflateDecoder
    };
    const customDecoders = options?.decoders || {};
    for (const codec of Object.keys(customDecoders)) {
      if (codec in this.#builtInDecoders) {
        throw new Error(`Cannot override built-in decoder for codec: ${codec}`);
      }
    }
    this.#decoders = {
      ...customDecoders
    };
  }
  async getHeader() {
    const header = await this.#parseHeader();
    return {
      magic: header.magic,
      meta: header.meta,
      sync: header.sync
    };
  }
  #getDecoder(codec) {
    if (codec in this.#builtInDecoders) {
      return this.#builtInDecoders[codec];
    }
    if (codec in this.#decoders) {
      return this.#decoders[codec];
    }
    throw new Error(`Unsupported codec: ${codec}. Provide a custom decoder.`);
  }
  async* iterRecords() {
    const header = await this.#parseHeader();
    const { schemaType, meta } = header;
    const resolver = this.#getResolver(schemaType);
    const codecBytes = meta.get("avro.codec");
    const codecStr = (() => {
      if (codecBytes === undefined) {
        return "null";
      }
      const decoded = new TextDecoder().decode(codecBytes);
      return decoded.length === 0 ? "null" : decoded;
    })();
    const decoder2 = this.#getDecoder(codecStr);
    const tap = this.#headerTap;
    while (await tap.canReadMore()) {
      const block = await BLOCK_TYPE.read(tap);
      const decompressedData = await decoder2.decode(block.data);
      const arrayBuffer = new ArrayBuffer(decompressedData.length);
      new Uint8Array(arrayBuffer).set(decompressedData);
      const recordTap = new ReadableTap(arrayBuffer);
      for (let i = 0n;i < block.count; i += 1n) {
        const record = resolver ? await resolver.read(recordTap) : await schemaType.read(recordTap);
        yield record;
      }
    }
  }
  async#parseHeader() {
    if (this.#header) {
      return this.#header;
    }
    const tap = new ReadableTap(this.#buffer);
    const header = await HEADER_TYPE.read(tap);
    const magic = header.magic;
    for (let i = 0;i < MAGIC_BYTES.length; i++) {
      if (magic[i] !== MAGIC_BYTES[i]) {
        throw new Error("Invalid AVRO file: incorrect magic bytes");
      }
    }
    const meta = header.meta;
    const schemaJson = meta.get("avro.schema");
    if (!schemaJson) {
      throw new Error("AVRO schema not found in metadata");
    }
    const schemaStr = new TextDecoder().decode(schemaJson);
    const schemaType = createType(JSON.parse(schemaStr));
    const codec = meta.get("avro.codec");
    if (codec && codec.length > 0) {
      const codecStr = new TextDecoder().decode(codec);
      this.#getDecoder(codecStr);
    }
    const sync = header.sync;
    this.#header = {
      magic,
      meta,
      sync,
      schemaType
    };
    this.#headerTap = tap;
    return this.#header;
  }
  #getResolver(writerType) {
    if (this.#readerSchema === undefined || this.#readerSchema === null) {
      return;
    }
    if (!this.#readerType) {
      this.#readerType = this.#createReaderType(this.#readerSchema);
    }
    if (!this.#resolver) {
      this.#resolver = this.#readerType.createResolver(writerType);
    }
    return this.#resolver;
  }
  #createReaderType(schema) {
    if (schema instanceof Type) {
      return schema;
    }
    if (typeof schema === "string") {
      const trimmed = schema.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        const parsed = JSON.parse(trimmed);
        return createType(parsed);
      }
      return createType(schema);
    }
    return createType(schema);
  }
}

// node_modules/@sachitv/avro-typescript/src/avro_reader.js
var DEFAULT_CACHE_SIZE = 0;

class AvroReaderInstanceImpl {
  #parser;
  #recordIterator;
  #closeHook;
  #closed = false;
  constructor(parser, closeHook) {
    this.#parser = parser;
    this.#recordIterator = parser.iterRecords();
    this.#closeHook = closeHook;
  }
  async getHeader() {
    return await this.#parser.getHeader();
  }
  iterRecords() {
    return this.#recordIterator;
  }
  async close() {
    if (this.#closed) {
      return;
    }
    if (this.#closeHook) {
      try {
        await this.#closeHook();
      } catch {}
      this.#closeHook = undefined;
    }
    this.#closed = true;
  }
}

class AvroReader {
  static fromBuffer(buffer, options) {
    const parser = new AvroFileParser(buffer, {
      readerSchema: options?.readerSchema,
      decoders: options?.decoders
    });
    return new AvroReaderInstanceImpl(parser, options?.closeHook);
  }
  static fromBlob(blob, options) {
    const buffer = new BlobReadableBuffer(blob);
    return AvroReader.fromBuffer(buffer, options);
  }
  static async fromUrl(url, options) {
    const response = await fetch(url, options?.fetchInit);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
      throw new Error(`Response body is null for ${url}`);
    }
    const stream = response.body;
    return AvroReader.fromStream(stream, {
      cacheSize: options?.cacheSize,
      readerSchema: options?.readerSchema,
      decoders: options?.decoders,
      closeHook: async () => {
        await stream.cancel();
      }
    });
  }
  static fromStream(stream, options) {
    const cacheSize = options?.cacheSize ?? DEFAULT_CACHE_SIZE;
    const streamBuffer = new StreamReadableBuffer(stream);
    let buffer;
    if (cacheSize > 0) {
      buffer = new FixedSizeStreamReadableBufferAdapter(streamBuffer, cacheSize);
    } else {
      buffer = new ForwardOnlyStreamReadableBufferAdapter(streamBuffer);
    }
    return AvroReader.fromBuffer(buffer, {
      readerSchema: options?.readerSchema,
      decoders: options?.decoders,
      closeHook: options?.closeHook
    });
  }
}
// node_modules/@sachitv/avro-typescript/src/serialization/encoders/deflate_encoder.js
class DeflateEncoder {
  async encode(uncompressedData) {
    if (typeof CompressionStream === "undefined") {
      throw new Error("Deflate codec not supported in this environment. CompressionStream API required.");
    }
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(uncompressedData);
        controller.close();
      }
    });
    const compressed = await new Response(stream.pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer();
    return new Uint8Array(compressed);
  }
}

// node_modules/@sachitv/avro-typescript/src/serialization/encoders/null_encoder.js
class NullEncoder {
  encode(uncompressedData) {
    return Promise.resolve(uncompressedData);
  }
}

// node_modules/@sachitv/avro-typescript/src/serialization/avro_file_writer.js
var DEFAULT_BLOCK_SIZE_BYTES = 64000;
var SYNC_MARKER_SIZE = 16;
var RESERVED_METADATA_KEYS = new Set([
  "avro.schema",
  "avro.codec"
]);

class AvroFileWriter {
  #tap;
  #schemaType;
  #codec;
  #encoder;
  #blockSize;
  #syncMarker;
  #metadata;
  #pendingRecords = [];
  #pendingBytes = 0;
  #pendingCount = 0;
  #headerPromise;
  #headerWritten = false;
  #closed = false;
  #builtInEncoders;
  #customEncoders;
  constructor(buffer, options) {
    if (!options || !options.schema) {
      throw new Error("Avro writer requires a schema.");
    }
    this.#tap = new WritableTap(buffer);
    this.#schemaType = createType(options.schema);
    this.#codec = options.codec ?? "null";
    this.#blockSize = this.#validateBlockSize(options.blockSize);
    this.#syncMarker = this.#initializeSyncMarker(options.syncMarker);
    this.#builtInEncoders = {
      null: new NullEncoder,
      deflate: new DeflateEncoder
    };
    this.#customEncoders = this.#validateCustomEncoders(options.encoders);
    this.#encoder = this.#resolveEncoder(this.#codec);
    this.#metadata = this.#buildMetadata(options.metadata);
    this.#metadata.set("avro.schema", encode(JSON.stringify(this.#schemaType.toJSON())));
    if (this.#codec !== "null") {
      this.#metadata.set("avro.codec", encode(this.#codec));
    }
  }
  async append(record) {
    this.#ensureOpen();
    await this.#ensureHeaderWritten();
    if (!this.#schemaType.isValid(record)) {
      throw new Error("Record does not conform to the schema.");
    }
    const recordBytes = await this.#encodeRecord(record);
    this.#pendingRecords.push(recordBytes);
    this.#pendingBytes += recordBytes.length;
    this.#pendingCount += 1;
    if (this.#pendingBytes >= this.#blockSize) {
      await this.flushBlock();
    }
  }
  async close() {
    if (this.#closed) {
      return;
    }
    await this.#ensureHeaderWritten();
    await this.flushBlock();
    this.#closed = true;
  }
  #ensureOpen() {
    if (this.#closed) {
      throw new Error("Avro writer is already closed.");
    }
  }
  #validateBlockSize(blockSize) {
    const size = blockSize ?? DEFAULT_BLOCK_SIZE_BYTES;
    if (!Number.isFinite(size) || !Number.isInteger(size) || size <= 0) {
      throw new RangeError("blockSize must be a positive integer byte count.");
    }
    return size;
  }
  #initializeSyncMarker(marker) {
    if (!marker) {
      const generated = new Uint8Array(SYNC_MARKER_SIZE);
      crypto.getRandomValues(generated);
      return generated;
    }
    if (marker.length !== SYNC_MARKER_SIZE) {
      throw new Error(`Sync marker must be ${SYNC_MARKER_SIZE} bytes long.`);
    }
    return marker.slice();
  }
  #validateCustomEncoders(encoders) {
    if (!encoders) {
      return {};
    }
    for (const codec of Object.keys(encoders)) {
      if (codec in this.#builtInEncoders) {
        throw new Error(`Cannot override built-in encoder for codec: ${codec}`);
      }
    }
    return {
      ...encoders
    };
  }
  #resolveEncoder(codec) {
    if (codec in this.#builtInEncoders) {
      return this.#builtInEncoders[codec];
    }
    if (codec in this.#customEncoders) {
      return this.#customEncoders[codec];
    }
    throw new Error(`Unsupported codec: ${codec}. Provide a custom encoder.`);
  }
  #buildMetadata(input) {
    const metadata = new Map;
    if (!input) {
      return metadata;
    }
    const setEntry = (key, value) => {
      this.#assertMetadataKey(key);
      if (value instanceof Uint8Array) {
        metadata.set(key, value.slice());
      } else {
        metadata.set(key, encode(value));
      }
    };
    if (input instanceof Map) {
      for (const [key, value] of input.entries()) {
        setEntry(key, value);
      }
    } else {
      for (const [key, value] of Object.entries(input)) {
        setEntry(key, value);
      }
    }
    return metadata;
  }
  #assertMetadataKey(key) {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("Metadata keys must be non-empty strings.");
    }
    if (RESERVED_METADATA_KEYS.has(key)) {
      throw new Error(`Metadata key "${key}" is reserved and managed by the Avro writer.`);
    }
  }
  async#ensureHeaderWritten() {
    if (this.#headerWritten) {
      return;
    }
    if (!this.#headerPromise) {
      this.#headerPromise = this.#writeHeader();
    }
    await this.#headerPromise;
  }
  async#writeHeader() {
    const header = {
      magic: MAGIC_BYTES,
      meta: this.#metadata,
      sync: this.#syncMarker
    };
    await HEADER_TYPE.write(this.#tap, header);
    this.#headerWritten = true;
  }
  async#encodeRecord(record) {
    const buffer = await this.#schemaType.toBuffer(record);
    return new Uint8Array(buffer);
  }
  async flushBlock() {
    this.#ensureOpen();
    await this.#ensureHeaderWritten();
    if (this.#pendingCount === 0) {
      return;
    }
    const combined = this.#combinePending();
    const encoded = await this.#encoder.encode(combined);
    const block = {
      count: BigInt(this.#pendingCount),
      data: encoded,
      sync: this.#syncMarker
    };
    await BLOCK_TYPE.write(this.#tap, block);
    this.#pendingRecords = [];
    this.#pendingBytes = 0;
    this.#pendingCount = 0;
  }
  #combinePending() {
    const combined = new Uint8Array(this.#pendingBytes);
    let offset = 0;
    for (const record of this.#pendingRecords) {
      combined.set(record, offset);
      offset += record.length;
    }
    return combined;
  }
}

// node_modules/@sachitv/avro-typescript/src/serialization/streams/stream_writable_buffer.js
class StreamWritableBuffer {
  #writer;
  constructor(stream) {
    this.#writer = stream.getWriter();
  }
  async writeBytes(data) {
    if (data.length === 0) {
      return;
    }
    await this.#writer.write(data);
  }
  async close() {
    await this.#writer.close();
    this.#writer.releaseLock();
  }
}

// node_modules/@sachitv/avro-typescript/src/serialization/streams/stream_writable_buffer_adapter.js
class StreamWritableBufferAdapter {
  #streamBuffer;
  #isClosed = false;
  constructor(streamBuffer) {
    this.#streamBuffer = streamBuffer;
  }
  async appendBytes(data) {
    if (this.#isClosed) {
      return;
    }
    await this.#streamBuffer.writeBytes(data);
  }
  async isValid() {
    return !this.#isClosed;
  }
  async canAppendMore(_size) {
    return await this.isValid();
  }
  async close() {
    if (!this.#isClosed) {
      this.#isClosed = true;
      await this.#streamBuffer.close();
    }
  }
}

// node_modules/@sachitv/avro-typescript/src/avro_writer.js
class AvroWriterInstanceImpl {
  #writer;
  #closeHook;
  #closed = false;
  constructor(writer, closeHook) {
    this.#writer = writer;
    this.#closeHook = closeHook;
  }
  async append(record) {
    await this.#writer.append(record);
  }
  async flushBlock() {
    await this.#writer.flushBlock();
  }
  async close() {
    if (this.#closed) {
      return;
    }
    await this.#writer.close();
    if (this.#closeHook) {
      await this.#closeHook();
      this.#closeHook = undefined;
    }
    this.#closed = true;
  }
}

class AvroWriter {
  static toBuffer(buffer, options) {
    const writer = new AvroFileWriter(buffer, options);
    return new AvroWriterInstanceImpl(writer);
  }
  static toStream(stream, options) {
    const streamBuffer = new StreamWritableBuffer(stream);
    const adapter = new StreamWritableBufferAdapter(streamBuffer);
    const writer = new AvroFileWriter(adapter, options);
    return new AvroWriterInstanceImpl(writer, async () => {
      await adapter.close();
    });
  }
}
// node_modules/@sachitv/avro-typescript/src/serialization/streams/stream_readable_buffer_adapter.js
class StreamReadableBufferAdapter {
  #bufferedData = null;
  #streamBuffer;
  #eof = false;
  constructor(streamBuffer) {
    this.#streamBuffer = streamBuffer;
  }
  async length() {
    await this.#ensureBuffered();
    return this.#bufferedData.length;
  }
  async read(offset, size) {
    if (offset < 0 || size < 0) {
      return;
    }
    if (this.#bufferedData !== null && offset + size <= this.#bufferedData.length) {
      return this.#bufferedData.slice(offset, offset + size);
    }
    await this.#ensureBufferedUpTo(offset + size);
    if (this.#bufferedData === null || offset + size > this.#bufferedData.length) {
      return;
    }
    return this.#bufferedData.slice(offset, offset + size);
  }
  async canReadMore(offset) {
    const result = await this.read(offset, 1);
    return result !== undefined;
  }
  async#ensureBuffered() {
    await this.#ensureBufferedUpTo(Infinity);
  }
  async#ensureBufferedUpTo(targetOffset) {
    if (this.#bufferedData === null) {
      this.#bufferedData = new Uint8Array(0);
    }
    while (!this.#eof && this.#bufferedData.length < targetOffset) {
      const chunk = await this.#streamBuffer.readNext();
      if (chunk === undefined) {
        this.#eof = true;
        break;
      }
      const currentLength = this.#bufferedData.length;
      const newBuffer = new Uint8Array(currentLength + chunk.length);
      newBuffer.set(this.#bufferedData);
      newBuffer.set(chunk, currentLength);
      this.#bufferedData = newBuffer;
    }
  }
}
// node_modules/@sachitv/avro-typescript/src/internal/crypto/md5.js
var S = [
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21
];
var K = new Uint32Array(64);
for (let i = 0;i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);
}
var textEncoder = new TextEncoder;
function md5FromString(value) {
  return md5(textEncoder.encode(value));
}
function md5(input) {
  const data = pad(input);
  let a = 1732584193;
  let b = 4023233417;
  let c = 2562383102;
  let d = 271733878;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let offset = 0;offset < data.byteLength; offset += 64) {
    const chunk = new Uint32Array(16);
    for (let i = 0;i < 16; i++) {
      chunk[i] = view.getUint32(offset + i * 4, true);
    }
    let A = a;
    let B = b;
    let C = c;
    let D = d;
    for (let i = 0;i < 64; i++) {
      let F;
      let g;
      if (i < 16) {
        F = B & C | ~B & D;
        g = i;
      } else if (i < 32) {
        F = D & B | ~D & C;
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = 7 * i % 16;
      }
      const temp = D;
      D = C;
      C = B;
      const sum = A + F + K[i] + chunk[g] >>> 0;
      const rotated = rotateLeft(sum, S[i]);
      B = B + rotated >>> 0;
      A = temp;
    }
    a = a + A >>> 0;
    b = b + B >>> 0;
    c = c + C >>> 0;
    d = d + D >>> 0;
  }
  const result = new Uint8Array(16);
  const resultView = new DataView(result.buffer);
  resultView.setUint32(0, a, true);
  resultView.setUint32(4, b, true);
  resultView.setUint32(8, c, true);
  resultView.setUint32(12, d, true);
  return result;
}
function rotateLeft(value, shift) {
  return (value << shift | value >>> 32 - shift) >>> 0;
}
function pad(input) {
  const bitLength = BigInt(input.length) * 8n;
  let paddingLength = 56 - (input.length + 1) % 64;
  if (paddingLength < 0) {
    paddingLength += 64;
  }
  const totalLength = input.length + 1 + paddingLength + 8;
  const output = new Uint8Array(totalLength);
  output.set(input, 0);
  output[input.length] = 128;
  const view = new DataView(output.buffer);
  view.setUint32(totalLength - 8, Number(bitLength & 0xffffffffn), true);
  view.setUint32(totalLength - 4, Number(bitLength >> 32n & 0xffffffffn), true);
  return output;
}

// node_modules/@sachitv/avro-typescript/src/rpc/definitions/message_definition.js
class Message {
  name;
  doc;
  requestType;
  responseType;
  errorType;
  oneWay;
  constructor(name, attrs, opts) {
    this.name = name;
    this.doc = attrs.doc;
    this.requestType = createType({
      name,
      type: "request",
      fields: attrs.request
    }, opts);
    if (!attrs.response) {
      throw new Error("missing response");
    }
    this.responseType = createType(attrs.response, opts);
    const errors = attrs.errors ? attrs.errors.slice() : [];
    errors.unshift("string");
    this.errorType = createType(errors, opts);
    this.oneWay = !!attrs["one-way"];
    if (this.oneWay) {
      if (!(this.responseType instanceof NullType)) {
        throw new Error("one-way messages must return 'null'");
      }
      if (this.errorType.getTypes().length > 1) {
        throw new Error("one-way messages cannot declare errors");
      }
    }
  }
  toJSON() {
    const json = {
      request: extractRequestFields(this.requestType),
      response: this.responseType.toJSON()
    };
    if (this.doc) {
      json.doc = this.doc;
    }
    if (this.oneWay) {
      json["one-way"] = true;
    }
    const errors = this.errorType.toJSON();
    if (Array.isArray(errors) && errors.length > 1) {
      json.errors = errors.slice(1);
    }
    return json;
  }
}
function extractRequestFields(requestType) {
  const json = requestType.toJSON();
  return json.fields;
}

// node_modules/@sachitv/avro-typescript/src/rpc/protocol/protocol_helpers.js
var textEncoder2 = new TextEncoder;
var textDecoder = new TextDecoder;
function normalizeProtocolName(name, namespace) {
  if (!name) {
    throw new Error("missing protocol name");
  }
  if (namespace && !name.includes(".")) {
    return `${namespace}.${name}`;
  }
  return name;
}
function stringifyProtocol(protocol) {
  const namedTypes = protocol.getNamedTypes();
  const messages = {};
  for (const [name, message] of protocol.getMessages()) {
    messages[name] = message;
  }
  return JSON.stringify({
    protocol: protocol.getName(),
    types: namedTypes.length ? namedTypes : undefined,
    messages
  });
}
function metadataWithId(id, base) {
  const map = new Map;
  if (base instanceof Map) {
    for (const [key, value] of base) {
      map.set(key, value.slice());
    }
  } else if (Array.isArray(base)) {
    for (const [key, value] of base) {
      map.set(key, value.slice());
    }
  } else if (base && typeof base === "object") {
    for (const [key, value] of Object.entries(base)) {
      map.set(key, value.slice());
    }
  }
  map.set("id", int32ToBytes(id));
  return map;
}
function int32ToBytes(value) {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setInt32(0, value, false);
  return new Uint8Array(buffer);
}
function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function bytesEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0;i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
function errorToPayload(err) {
  if (err instanceof Error) {
    return {
      string: err.message
    };
  }
  if (typeof err === "string") {
    return {
      string: err
    };
  }
  return {
    string: String(err)
  };
}

// node_modules/@sachitv/avro-typescript/src/internal/collections/array_utils.js
function concatUint8Arrays(parts) {
  if (parts.length === 0) {
    return new Uint8Array(0);
  }
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function toUint8Array(data) {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

// node_modules/@sachitv/avro-typescript/src/rpc/protocol/wire_format/metadata.js
function isIterableMetadata(value) {
  if (value === undefined || value === null) {
    return false;
  }
  if (value instanceof Map) {
    return true;
  }
  return typeof value[Symbol.iterator] === "function";
}
function cloneBytes(value, field) {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${field} must be a Uint8Array.`);
  }
  return new Uint8Array(value);
}
function toMetadataMap(init) {
  const map = new Map;
  if (isIterableMetadata(init)) {
    for (const [key, value] of init) {
      if (typeof key !== "string") {
        throw new TypeError("Metadata keys must be strings.");
      }
      map.set(key, cloneBytes(value, `Metadata value for '${key}'`));
    }
    return map;
  }
  for (const [key, value] of Object.entries(init)) {
    map.set(key, cloneBytes(value, `Metadata value for '${key}'`));
  }
  return map;
}
function toOptionalMetadataMap(init) {
  if (init === undefined || init === null) {
    return null;
  }
  return toMetadataMap(init);
}
function toRequiredMetadataMap(init) {
  if (init === undefined || init === null) {
    return new Map;
  }
  return toMetadataMap(init);
}
function cloneMetadataMap(map) {
  const clone = new Map;
  for (const [key, value] of map.entries()) {
    clone.set(key, cloneBytes(value, `Metadata value for '${key}'`));
  }
  return clone;
}

// node_modules/@sachitv/avro-typescript/src/rpc/protocol/wire_format/handshake.js
var handshakeRegistry = new Map;
var HANDSHAKE_REQUEST_TYPE = createType({
  namespace: "org.apache.avro.ipc",
  name: "HandshakeRequest",
  type: "record",
  fields: [
    {
      name: "clientHash",
      type: {
        name: "MD5",
        type: "fixed",
        size: 16
      }
    },
    {
      name: "clientProtocol",
      type: [
        "null",
        "string"
      ],
      default: null
    },
    {
      name: "serverHash",
      type: "org.apache.avro.ipc.MD5"
    },
    {
      name: "meta",
      type: [
        "null",
        {
          type: "map",
          values: "bytes"
        }
      ],
      default: null
    }
  ]
}, {
  registry: handshakeRegistry
});
var HANDSHAKE_RESPONSE_TYPE = createType({
  namespace: "org.apache.avro.ipc",
  name: "HandshakeResponse",
  type: "record",
  fields: [
    {
      name: "match",
      type: {
        name: "HandshakeMatch",
        type: "enum",
        symbols: [
          "BOTH",
          "CLIENT",
          "NONE"
        ]
      }
    },
    {
      name: "serverProtocol",
      type: [
        "null",
        "string"
      ],
      default: null
    },
    {
      name: "serverHash",
      type: [
        "null",
        "org.apache.avro.ipc.MD5"
      ],
      default: null
    },
    {
      name: "meta",
      type: [
        "null",
        {
          type: "map",
          values: "bytes"
        }
      ],
      default: null
    }
  ]
}, {
  registry: handshakeRegistry
});
var STRING_BRANCH = "string";
var MAP_BRANCH = "map";
var MD5_BRANCH = "org.apache.avro.ipc.MD5";
function _assertMd5Size(value, field) {
  if (value.length !== 16) {
    throw new RangeError(`${field} must contain exactly 16 bytes.`);
  }
}
function _wrapUnion(branch, value) {
  return {
    [branch]: value
  };
}
function _createHandshakeRequestRecord(message) {
  const clientHash = cloneBytes(message.clientHash, "clientHash");
  _assertMd5Size(clientHash, "clientHash");
  const serverHash = cloneBytes(message.serverHash, "serverHash");
  _assertMd5Size(serverHash, "serverHash");
  const clientProtocol = message.clientProtocol ?? null;
  let clientProtocolUnion;
  if (clientProtocol === null) {
    clientProtocolUnion = null;
  } else if (typeof clientProtocol === "string") {
    clientProtocolUnion = _wrapUnion(STRING_BRANCH, clientProtocol);
  } else {
    throw new TypeError("clientProtocol must be a string or null.");
  }
  const meta = toOptionalMetadataMap(message.meta);
  const metaUnion = meta === null ? null : _wrapUnion(MAP_BRANCH, meta);
  return {
    clientHash,
    clientProtocol: clientProtocolUnion,
    serverHash,
    meta: metaUnion
  };
}
function _createHandshakeResponseRecord(message) {
  const serverHash = message.serverHash ?? null;
  let serverHashUnion;
  if (serverHash === null) {
    serverHashUnion = null;
  } else {
    const hashBytes = cloneBytes(serverHash, "serverHash");
    _assertMd5Size(hashBytes, "serverHash");
    serverHashUnion = _wrapUnion(MD5_BRANCH, hashBytes);
  }
  const serverProtocol = message.serverProtocol ?? null;
  let serverProtocolUnion;
  if (serverProtocol === null) {
    serverProtocolUnion = null;
  } else if (typeof serverProtocol === "string") {
    serverProtocolUnion = _wrapUnion(STRING_BRANCH, serverProtocol);
  } else {
    throw new TypeError("serverProtocol must be a string or null.");
  }
  const meta = toOptionalMetadataMap(message.meta);
  const metaUnion = meta === null ? null : _wrapUnion(MAP_BRANCH, meta);
  return {
    match: message.match,
    serverProtocol: serverProtocolUnion,
    serverHash: serverHashUnion,
    meta: metaUnion
  };
}
function _extractOptionalString(unionValue) {
  if (unionValue === null) {
    return null;
  }
  if (unionValue[STRING_BRANCH] !== undefined) {
    return unionValue[STRING_BRANCH];
  }
  throw new Error("Unexpected union value for string branch.");
}
function _extractOptionalMetadata(unionValue) {
  if (unionValue === null) {
    return null;
  }
  const map = unionValue[MAP_BRANCH];
  if (map === undefined) {
    throw new Error("Unexpected union value for metadata branch.");
  }
  return cloneMetadataMap(map);
}
function _extractOptionalMd5(unionValue) {
  if (unionValue === null) {
    return null;
  }
  const value = unionValue[MD5_BRANCH];
  if (value === undefined) {
    throw new Error("Unexpected union value for MD5 branch.");
  }
  return cloneBytes(value, "serverHash");
}
function _toHandshakeRequestMessage(record) {
  return {
    clientHash: cloneBytes(record.clientHash, "clientHash"),
    clientProtocol: _extractOptionalString(record.clientProtocol),
    serverHash: cloneBytes(record.serverHash, "serverHash"),
    meta: _extractOptionalMetadata(record.meta)
  };
}
function _toHandshakeResponseMessage(record) {
  return {
    match: record.match,
    serverProtocol: _extractOptionalString(record.serverProtocol),
    serverHash: _extractOptionalMd5(record.serverHash),
    meta: _extractOptionalMetadata(record.meta)
  };
}
async function encodeHandshakeRequest(message) {
  const record = _createHandshakeRequestRecord(message);
  return new Uint8Array(await HANDSHAKE_REQUEST_TYPE.toBuffer(record));
}
async function readHandshakeRequestFromTap(tap) {
  const record = await HANDSHAKE_REQUEST_TYPE.read(tap);
  return _toHandshakeRequestMessage(record);
}
async function encodeHandshakeResponse(message) {
  const record = _createHandshakeResponseRecord(message);
  return new Uint8Array(await HANDSHAKE_RESPONSE_TYPE.toBuffer(record));
}
async function readHandshakeResponseFromTap(tap) {
  const record = await HANDSHAKE_RESPONSE_TYPE.read(tap);
  return _toHandshakeResponseMessage(record);
}

// node_modules/@sachitv/avro-typescript/src/rpc/protocol/wire_format/messages.js
var MAP_OF_BYTES_TYPE = createType({
  type: "map",
  values: "bytes"
});
var STRING_TYPE = createType("string");
var BOOLEAN_TYPE = createType("boolean");
async function readOptionalHandshake(buffer, reader, expectHandshake) {
  const tap = new ReadableTap(buffer);
  if (expectHandshake) {
    const handshake = await reader(tap);
    return {
      handshake,
      tap
    };
  }
  const initialPos = tap.getPos();
  try {
    const handshake = await reader(tap);
    return {
      handshake,
      tap
    };
  } catch {
    return {
      tap: new ReadableTap(buffer, initialPos)
    };
  }
}
async function encodeCallRequest(init) {
  const parts = [];
  if (init.handshake) {
    parts.push(await encodeHandshakeRequest(init.handshake));
  }
  const metadata = toRequiredMetadataMap(init.metadata);
  parts.push(new Uint8Array(await MAP_OF_BYTES_TYPE.toBuffer(metadata)));
  parts.push(new Uint8Array(await STRING_TYPE.toBuffer(init.messageName)));
  parts.push(new Uint8Array(await init.requestType.toBuffer(init.request)));
  return concatUint8Arrays(parts);
}
async function decodeCallRequestEnvelope(buffer, options = {}) {
  const { expectHandshake = false } = options;
  const { handshake: handshakeResult, tap: handshakeTap } = await readOptionalHandshake(buffer, readHandshakeRequestFromTap, expectHandshake);
  const handshake = handshakeResult;
  const tap = handshakeTap;
  const metadataMap = await MAP_OF_BYTES_TYPE.read(tap);
  const metadata = cloneMetadataMap(metadataMap);
  const messageName = await STRING_TYPE.read(tap);
  return {
    handshake,
    metadata,
    messageName,
    bodyTap: tap
  };
}
async function encodeCallResponse(init) {
  const parts = [];
  if (init.handshake) {
    parts.push(await encodeHandshakeResponse(init.handshake));
  }
  const metadata = toRequiredMetadataMap(init.metadata);
  parts.push(new Uint8Array(await MAP_OF_BYTES_TYPE.toBuffer(metadata)));
  parts.push(new Uint8Array(await BOOLEAN_TYPE.toBuffer(init.isError)));
  if (init.isError) {
    parts.push(new Uint8Array(await init.errorType.toBuffer(init.payload)));
  } else {
    parts.push(new Uint8Array(await init.responseType.toBuffer(init.payload)));
  }
  return concatUint8Arrays(parts);
}
async function decodeCallResponseEnvelope(buffer, options = {}) {
  const { expectHandshake = false } = options;
  const { handshake: handshakeResult, tap: handshakeTap } = await readOptionalHandshake(buffer, readHandshakeResponseFromTap, expectHandshake);
  const handshake = handshakeResult;
  const tap = handshakeTap;
  const metadataMap = await MAP_OF_BYTES_TYPE.read(tap);
  const metadata = cloneMetadataMap(metadataMap);
  const isError = await BOOLEAN_TYPE.read(tap);
  return {
    handshake,
    metadata,
    isError,
    bodyTap: tap
  };
}

// node_modules/@sachitv/avro-typescript/src/rpc/protocol/wire_format/framing.js
var DEFAULT_FRAME_SIZE = 8 * 1024;
var FRAME_HEADER_SIZE = 4;
function normalizeFrameSize(frameSize) {
  if (frameSize === undefined) {
    return DEFAULT_FRAME_SIZE;
  }
  if (!Number.isInteger(frameSize) || frameSize <= 0) {
    throw new RangeError("frameSize must be a positive integer.");
  }
  return frameSize;
}
function frameMessage(payload, options) {
  const bytes = toUint8Array(payload);
  const frameSize = normalizeFrameSize(options?.frameSize);
  const frames = [];
  let offset = 0;
  while (offset < bytes.length) {
    const chunkSize = Math.min(frameSize, bytes.length - offset);
    const header = new Uint8Array(FRAME_HEADER_SIZE);
    new DataView(header.buffer).setUint32(0, chunkSize, false);
    frames.push(header);
    frames.push(bytes.subarray(offset, offset + chunkSize));
    offset += chunkSize;
  }
  frames.push(new Uint8Array(FRAME_HEADER_SIZE));
  return frames.length === 1 ? frames[0] : concatUint8Arrays(frames);
}

// node_modules/@sachitv/avro-typescript/src/rpc/protocol/transports/transport_helpers.js
var textEncoder3 = new TextEncoder;
function toBinaryDuplex(input) {
  return {
    readable: toBinaryReadable(input.readable),
    writable: toBinaryWritable(input.writable)
  };
}
function toBinaryReadable(source) {
  if (isBinaryReadable(source)) {
    return source;
  }
  if (!isReadableStream(source)) {
    throw new TypeError("Unsupported readable transport.");
  }
  const reader = source.getReader();
  return {
    async read() {
      const { value, done } = await reader.read();
      if (done) {
        return null;
      } else {
        if (value === undefined) {
          return new Uint8Array(0);
        } else {
          return value;
        }
      }
    }
  };
}
function toBinaryWritable(target) {
  if (isBinaryWritable(target)) {
    return target;
  }
  if (!isWritableStream(target)) {
    throw new TypeError("Unsupported writable transport.");
  }
  const writer = target.getWriter();
  return {
    async write(chunk) {
      await writer.write(chunk);
    },
    async close() {
      await writer.close();
    }
  };
}
function isBinaryReadable(value) {
  return typeof value === "object" && value !== null && typeof value.read === "function";
}
function isBinaryWritable(value) {
  return typeof value === "object" && value !== null && typeof value.write === "function" && typeof value.close === "function";
}
function isReadableStream(value) {
  return typeof ReadableStream !== "undefined" && value instanceof ReadableStream;
}
function isWritableStream(value) {
  return typeof WritableStream !== "undefined" && value instanceof WritableStream;
}

// node_modules/@sachitv/avro-typescript/src/rpc/message_endpoint/base.js
class MessageEndpoint extends EventTarget {
  protocol;
  bufferSize;
  frameSize;
  constructor(protocol, opts) {
    super();
    this.protocol = protocol;
    this.bufferSize = opts.bufferSize ?? 2048;
    this.frameSize = opts.frameSize ?? 2048;
  }
  dispatchError(err) {
    let error;
    if (err instanceof Error) {
      error = err;
    } else {
      error = new Error(String(err));
    }
    if (typeof ErrorEvent === "function") {
      this.dispatchEvent(new ErrorEvent("error", {
        error
      }));
    } else {
      this.dispatchEvent(new CustomEvent("error", {
        detail: error
      }));
    }
  }
  dispatchHandshake(request, response) {
    this.dispatchEvent(new CustomEvent("handshake", {
      detail: {
        request,
        response
      }
    }));
  }
  dispatchEot(pending) {
    this.dispatchEvent(new CustomEvent("eot", {
      detail: {
        pending
      }
    }));
  }
}

// node_modules/@sachitv/avro-typescript/src/rpc/protocol/frame_assembler.js
class FrameAssembler {
  #buffer = new Uint8Array(0);
  #frames = [];
  push(chunk) {
    if (!chunk.length) {
      return [];
    }
    if (!this.#buffer.length) {
      this.#buffer = chunk.slice();
    } else {
      const combined = new Uint8Array(this.#buffer.length + chunk.length);
      combined.set(this.#buffer, 0);
      combined.set(chunk, this.#buffer.length);
      this.#buffer = combined;
    }
    const output = [];
    let offset = 0;
    while (this.#buffer.length - offset >= 4) {
      const frameLength = this.#readUint32BE(offset);
      offset += 4;
      if (frameLength === 0) {
        output.push(this.#flushFrames());
        continue;
      }
      if (offset + frameLength > this.#buffer.length) {
        offset -= 4;
        break;
      }
      this.#frames.push(this.#buffer.subarray(offset, offset + frameLength));
      offset += frameLength;
    }
    if (offset > 0) {
      this.#buffer = this.#buffer.subarray(offset);
    }
    return output;
  }
  reset() {
    this.#buffer = new Uint8Array(0);
    this.#frames = [];
  }
  #flushFrames() {
    if (!this.#frames.length) {
      return new Uint8Array(0);
    }
    const payload = this.#frames.length === 1 ? this.#frames[0] : concatUint8Arrays(this.#frames);
    this.#frames = [];
    return payload;
  }
  #readUint32BE(offset) {
    const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset + offset, 4);
    return view.getUint32(0, false);
  }
}

// node_modules/@sachitv/avro-typescript/src/rpc/message_endpoint/helpers.js
async function readSingleMessage(readable) {
  const assembler = new FrameAssembler;
  while (true) {
    const chunk = await readable.read();
    if (chunk === null) {
      break;
    }
    const messages = assembler.push(chunk);
    if (messages.length) {
      return messages[0];
    }
  }
  throw new Error("no framed message received");
}
async function drainReadable(readable) {
  while (await readable.read() !== null) {}
}
async function readResponsePayload(envelope, message, resolver) {
  const tap = envelope.bodyTap;
  if (envelope.isError) {
    if (resolver?.error) {
      return await resolver.error.read(tap);
    }
    return await message.errorType.read(tap);
  }
  if (resolver?.response) {
    return await resolver.response.read(tap);
  }
  return await message.responseType.read(tap);
}
async function readRequestPayload(envelope, message, resolver) {
  if (resolver?.request) {
    return await resolver.request.read(envelope.bodyTap);
  }
  return await message.requestType.read(envelope.bodyTap);
}

// node_modules/@sachitv/avro-typescript/src/rpc/message_endpoint/listener.js
class MessageListener extends MessageEndpoint {
}

class StatelessListener extends MessageListener {
  #transport;
  #destroyed = false;
  #protocolFactory;
  #requestDecoder;
  #runPromise;
  #exposeProtocol;
  #maxRequestSize;
  #requestTimeout;
  constructor(protocol, transport, opts, protocolFactory) {
    super(protocol, opts);
    this.#transport = transport;
    this.#protocolFactory = protocolFactory;
    this.#requestDecoder = opts.requestDecoder ?? decodeCallRequestEnvelope;
    this.#exposeProtocol = opts.exposeProtocol ?? false;
    this.#maxRequestSize = opts.maxRequestSize ?? 10 * 1024 * 1024;
    this.#requestTimeout = opts.requestTimeout ?? 30000;
    this.#runPromise = this.#run();
  }
  destroy() {
    if (!this.#destroyed) {
      this.#destroyed = true;
      this.dispatchEot(0);
    }
  }
  waitForClose() {
    return this.#runPromise;
  }
  async#run() {
    const duplex = toBinaryDuplex(this.#transport);
    const assembler = new FrameAssembler;
    let totalSize = 0;
    try {
      const timeoutController = new AbortController;
      const timeoutId = setTimeout(() => {
        timeoutController.abort();
      }, this.#requestTimeout);
      try {
        while (!timeoutController.signal.aborted) {
          const chunk = await duplex.readable.read();
          if (chunk === null) {
            break;
          }
          totalSize += chunk.length;
          if (totalSize > this.#maxRequestSize) {
            throw new Error(`request too large: ${totalSize} bytes (max: ${this.#maxRequestSize})`);
          }
          const messages = assembler.push(chunk);
          if (messages.length > 0) {
            await this.#handleRequest(messages[0], duplex);
            return;
          }
        }
        if (timeoutController.signal.aborted) {
          throw new Error("request timeout");
        }
        throw new Error("no request payload");
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      this.dispatchError(err);
    } finally {
      await duplex.writable.close();
      this.destroy();
    }
  }
  async#handleRequest(payload, duplex) {
    const envelope = await this.#requestDecoder(toArrayBuffer(payload), {
      expectHandshake: true
    });
    if (!envelope.handshake) {
      throw new Error("missing handshake request");
    }
    const { response: handshakeResponse, requestResolverKey } = await this.#validateHandshake(envelope.handshake);
    let message;
    let result;
    let isError = false;
    let errorPayload;
    try {
      message = this.protocol.getMessages().get(envelope.messageName);
      if (!message) {
        throw new Error(`unsupported message: ${envelope.messageName}`);
      }
      const resolver = this.protocol.getListenerResolvers(requestResolverKey, message.name);
      const requestValue = await readRequestPayload(envelope, message, resolver);
      const handler = this.protocol.getHandler(message.name);
      if (!handler) {
        throw new Error(`unsupported message: ${message.name}`);
      }
      result = await handler(requestValue, this, {
        metadata: envelope.metadata
      });
    } catch (err) {
      isError = true;
      errorPayload = errorToPayload(err);
    }
    const responsePayload = await encodeCallResponse({
      handshake: handshakeResponse,
      metadata: envelope.metadata,
      isError,
      payload: isError ? errorPayload : result,
      responseType: message ? message.responseType : createType("null"),
      errorType: message ? message.errorType : createType([
        "string"
      ])
    });
    const framed = frameMessage(responsePayload, {
      frameSize: this.frameSize
    });
    await duplex.writable.write(framed);
  }
  async#validateHandshake(handshake) {
    let validationError = null;
    let resolverError = null;
    const clientHashKey = bytesToHex(handshake.clientHash);
    const needsResolver = clientHashKey !== this.protocol.hashKey;
    if (needsResolver && !this.protocol.hasListenerResolvers(clientHashKey)) {
      if (handshake.clientProtocol) {
        if (typeof handshake.clientProtocol !== "string" || handshake.clientProtocol.length > 1024 * 1024) {
          validationError = new Error("invalid client protocol: too large or not a string");
        } else {
          try {
            const parsedProtocol = JSON.parse(handshake.clientProtocol);
            const emitterProtocol = this.#protocolFactory(parsedProtocol);
            this.protocol.ensureListenerResolvers(clientHashKey, emitterProtocol);
          } catch (err) {
            validationError = err instanceof Error ? err : new Error("invalid client protocol JSON");
          }
        }
      } else {
        resolverError = new Error("unknown client protocol hash");
      }
    }
    const handshakeIssue = validationError ?? resolverError;
    const serverMatch = bytesEqual(handshake.serverHash, this.protocol.getHashBytes());
    const clientHashKnown = !needsResolver;
    const shouldExposeProtocol = (!serverMatch && clientHashKnown || this.#exposeProtocol) && !validationError;
    const response = {
      match: handshakeIssue ? "NONE" : serverMatch ? "BOTH" : "CLIENT",
      serverProtocol: shouldExposeProtocol ? this.protocol.toString() : null,
      serverHash: serverMatch ? null : this.protocol.getHashBytes(),
      meta: validationError ? new Map([
        [
          "error",
          textEncoder2.encode(String(validationError))
        ]
      ]) : resolverError ? new Map([
        [
          "error",
          textEncoder2.encode(String(resolverError))
        ]
      ]) : null
    };
    return {
      response,
      requestResolverKey: clientHashKey
    };
  }
}

// node_modules/@sachitv/avro-typescript/src/rpc/message_endpoint/emitter.js
class MessageEmitter extends MessageEndpoint {
  #serverHash;
  #serverHashKey;
  #destroyed = false;
  constructor(protocol, opts) {
    super(protocol, opts);
    this.#serverHash = protocol.getHashBytes();
    this.#serverHashKey = protocol.hashKey;
  }
  get destroyed() {
    return this.#destroyed;
  }
  destroy() {
    if (!this.#destroyed) {
      this.#destroyed = true;
      this.dispatchEot(0);
    }
  }
  get serverHash() {
    return this.#serverHash;
  }
  updateServerHash(bytes) {
    this.#serverHash = bytes.slice();
    this.#serverHashKey = bytesToHex(bytes);
  }
  get serverHashKey() {
    return this.#serverHashKey;
  }
  buildHandshakeRequest(omitProtocol) {
    return {
      clientHash: this.protocol.getHashBytes(),
      clientProtocol: omitProtocol ? null : this.protocol.toString(),
      serverHash: this.#serverHash
    };
  }
  finalizeHandshake(request, response) {
    this.dispatchHandshake(request, response);
    if (response.match === "NONE") {
      const reason = response.meta?.get("error");
      if (reason) {
        throw new Error(new TextDecoder().decode(reason));
      }
    }
    if (!response.serverHash) {
      return {
        retry: false,
        serverHash: this.#serverHash
      };
    }
    this.updateServerHash(response.serverHash);
    let retry = false;
    if (response.match === "NONE" && request.clientProtocol === null) {
      retry = true;
    }
    return {
      retry,
      serverHash: response.serverHash
    };
  }
}

class StatelessEmitter extends MessageEmitter {
  #transportFactory;
  #pending = new Set;
  #nextId = 1;
  #protocolFactory;
  constructor(protocol, transportFactory, opts, protocolFactory) {
    super(protocol, opts);
    this.#transportFactory = transportFactory;
    this.#protocolFactory = protocolFactory;
  }
  destroy() {
    if (this.destroyed) {
      return;
    }
    for (const pending of this.#pending) {
      pending.reject(new Error("emitter destroyed"));
    }
    this.#pending.clear();
    super.destroy();
  }
  async send(message, request) {
    if (this.destroyed) {
      throw new Error("emitter destroyed");
    }
    if (message.oneWay) {
      await this.#performCall(message, request, true);
      return;
    }
    const promise = this.#performCall(message, request, false);
    return await this.#trackPending(promise);
  }
  async#trackPending(promise) {
    let resolve;
    let reject;
    const wrapped = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const pending = {
      resolve,
      reject
    };
    this.#pending.add(pending);
    promise.then((value) => {
      if (this.#pending.delete(pending)) {
        pending.resolve(value);
      }
    }).catch((err) => {
      if (this.#pending.delete(pending)) {
        pending.reject(err);
      }
    });
    return await wrapped;
  }
  async#performCall(message, request, oneWay) {
    let omitProtocol = true;
    while (true) {
      const transport = toBinaryDuplex(await this.#transportFactory());
      const metadata = metadataWithId(this.#nextId++);
      const handshake = this.buildHandshakeRequest(omitProtocol);
      const encoded = await encodeCallRequest({
        handshake,
        metadata,
        messageName: message.name,
        request,
        requestType: message.requestType
      });
      const framed = frameMessage(encoded, {
        frameSize: this.frameSize
      });
      await transport.writable.write(framed);
      await transport.writable.close();
      if (oneWay) {
        await drainReadable(transport.readable);
        return;
      }
      const payload = await readSingleMessage(transport.readable);
      const envelope = await decodeCallResponseEnvelope(toArrayBuffer(payload), {
        expectHandshake: true
      });
      const handshakeResponse = envelope.handshake;
      const outcome = this.finalizeHandshake(handshake, handshakeResponse);
      if (handshakeResponse.serverProtocol) {
        const remote = this.#protocolFactory(JSON.parse(handshakeResponse.serverProtocol));
        this.protocol.ensureEmitterResolvers(bytesToHex(outcome.serverHash), remote);
      }
      if (outcome.retry) {
        omitProtocol = false;
        continue;
      }
      const resolvers = this.protocol.getEmitterResolvers(bytesToHex(outcome.serverHash), message.name);
      const payloadValue = await readResponsePayload(envelope, message, resolvers);
      return payloadValue;
    }
  }
}

// node_modules/@sachitv/avro-typescript/src/rpc/protocol_core.js
class Protocol {
  #name;
  #namespace;
  #messages;
  #types;
  #parent;
  #handlers = new Map;
  #hashBytes;
  #hashKey;
  #emitterResolvers = new Map;
  #listenerResolvers = new Map;
  constructor(name, namespace, messages, types, parent) {
    this.#name = name;
    this.#namespace = namespace;
    this.#messages = messages;
    this.#types = types;
    this.#parent = parent;
    const canonical = stringifyProtocol(this);
    this.#hashBytes = md5FromString(canonical);
    this.#hashKey = bytesToHex(this.#hashBytes);
  }
  static create(attrs, opts = {}) {
    const name = normalizeProtocolName(attrs.protocol, attrs.namespace ?? opts.namespace);
    const registry = opts.registry ?? new Map;
    const createOpts = {
      namespace: attrs.namespace ?? opts.namespace,
      registry
    };
    if (attrs.types) {
      for (const schema of attrs.types) {
        createType(schema, createOpts);
      }
    }
    const messages = new Map;
    if (attrs.messages) {
      for (const [messageName, definition] of Object.entries(attrs.messages)) {
        messages.set(messageName, new Message(messageName, definition, createOpts));
      }
    }
    return new Protocol(name, attrs.namespace ?? opts.namespace, messages, registry);
  }
  subprotocol() {
    return new Protocol(this.#name, this.#namespace, this.#messages, this.#types, this);
  }
  getName() {
    return this.#name;
  }
  toString() {
    return stringifyProtocol(this);
  }
  get hashKey() {
    return this.#hashKey;
  }
  getHashBytes() {
    return this.#hashBytes.slice();
  }
  getMessages() {
    return this.#messages;
  }
  getNamedTypes() {
    const named = [];
    for (const type of this.#types.values()) {
      if (type instanceof NamedType) {
        named.push(type);
      }
    }
    return named;
  }
  getMessage(name) {
    return this.#messages.get(name);
  }
  getMessageNames() {
    return Array.from(this.#messages.keys());
  }
  getMessageDefinition(name) {
    const message = this.#messages.get(name);
    if (!message) {
      return;
    }
    const json = message.toJSON();
    return json;
  }
  getProtocolInfo() {
    return {
      name: this.#name,
      namespace: this.#namespace,
      hashKey: this.#hashKey,
      hashBytes: this.#hashBytes,
      messageNames: this.getMessageNames()
    };
  }
  getType(name) {
    return this.#types.get(name);
  }
  on(name, handler) {
    if (!this.#messages.has(name)) {
      throw new Error(`unknown message: ${name}`);
    }
    this.#handlers.set(name, handler);
    return this;
  }
  async emit(name, request, emitter) {
    const message = this.#messages.get(name);
    if (!message) {
      throw new Error(`unknown message: ${name}`);
    }
    if (emitter.protocol.hashKey !== this.hashKey) {
      throw new Error("invalid emitter");
    }
    return await emitter.send(message, request);
  }
  createEmitter(transport, opts = {}) {
    if (typeof transport === "function") {
      return new StatelessEmitter(this, transport, opts, Protocol.create);
    }
    throw new Error("Stateful transports are not supported yet.");
  }
  createListener(transport, opts = {}) {
    if (opts.mode && opts.mode !== "stateless") {
      throw new Error("Stateful listeners are not supported yet.");
    }
    return new StatelessListener(this, transport, opts, Protocol.create);
  }
  getHandler(name) {
    const handler = this.#handlers.get(name);
    if (handler) {
      return handler;
    }
    return this.#parent?.getHandler(name);
  }
  getEmitterResolvers(hashKey, messageName) {
    return this.#emitterResolvers.get(hashKey)?.get(messageName);
  }
  getListenerResolvers(hashKey, messageName) {
    return this.#listenerResolvers.get(hashKey)?.get(messageName);
  }
  hasListenerResolvers(hashKey) {
    return this.#listenerResolvers.has(hashKey);
  }
  hasEmitterResolvers(hashKey) {
    return this.#emitterResolvers.has(hashKey);
  }
  ensureEmitterResolvers(hashKey, remote) {
    if (this.#emitterResolvers.has(hashKey)) {
      return;
    }
    const resolvers = new Map;
    for (const [name, localMessage] of this.#messages.entries()) {
      const remoteMessage = remote.getMessages().get(name);
      if (!remoteMessage) {
        throw new Error(`missing server message: ${name}`);
      }
      resolvers.set(name, {
        response: localMessage.responseType.createResolver(remoteMessage.responseType),
        error: localMessage.errorType.createResolver(remoteMessage.errorType)
      });
    }
    this.#emitterResolvers.set(hashKey, resolvers);
  }
  ensureListenerResolvers(hashKey, emitterProtocol) {
    if (this.#listenerResolvers.has(hashKey)) {
      return;
    }
    const resolvers = new Map;
    for (const [name, serverMessage] of this.#messages.entries()) {
      const clientMessage = emitterProtocol.getMessages().get(name);
      if (!clientMessage) {
        throw new Error(`missing client message: ${name}`);
      }
      resolvers.set(name, {
        request: serverMessage.requestType.createResolver(clientMessage.requestType)
      });
    }
    this.#listenerResolvers.set(hashKey, resolvers);
  }
}
// browser.ts
var schema = {
  type: "record",
  name: "User",
  fields: [
    { name: "id", type: "long" },
    { name: "username", type: "string" },
    { name: "email", type: "string" },
    { name: "age", type: "int" }
  ]
};
var userType = createType(schema);
var users = [
  { id: 1n, username: "user1", email: "user1@example.com", age: 25 },
  { id: 2n, username: "user2", email: "user2@example.com", age: 30 }
];

class MemoryWritableBuffer {
  chunks = [];
  _isValid = true;
  appendBytes(data) {
    if (!this._isValid) {
      throw new Error("Buffer is not valid");
    }
    this.chunks.push(data);
  }
  isValid() {
    return this._isValid;
  }
  close() {
    this._isValid = false;
  }
  getBuffer() {
    let totalLength = 0;
    for (const chunk of this.chunks) {
      totalLength += chunk.length;
    }
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
}
async function runExample() {
  const outputElement = document.getElementById("output");
  if (!outputElement) {
    console.error("Output element not found");
    return;
  }
  outputElement.textContent = "Running...";
  const memoryBuffer = new MemoryWritableBuffer;
  const writer = AvroWriter.toBuffer(memoryBuffer, { schema: userType });
  for (const user of users) {
    await writer.append(user);
  }
  await writer.close();
  const avroBuffer = memoryBuffer.getBuffer();
  const reader = AvroReader.fromBuffer(avroBuffer.buffer);
  let outputText = `Avro data written to and read from in-memory buffer:

`;
  for await (const record of reader.iterRecords()) {
    outputText += JSON.stringify(record, (key, value) => typeof value === "bigint" ? value.toString() + "n" : value, 2) + `
`;
  }
  await reader.close();
  outputElement.textContent = outputText;
}
var runButton = document.getElementById("run-button");
if (runButton) {
  runButton.addEventListener("click", runExample);
}
