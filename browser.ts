import { createType, AvroReader, AvroWriter } from "@sachitv/avro-typescript";
import type { IWritableBuffer } from "@sachitv/avro-typescript/io/types";

// 1. Define an Avro schema
const schema = {
  type: "record",
  name: "User",
  fields: [
    { name: "id", type: "long" },
    { name: "username", type: "string" },
    { name: "email", type: "string" },
    { name: "age", type: "int" },
  ],
};

// 2. Create a Type from the schema
const userType = createType(schema);

// 3. Create some user data
const users = [
  { id: 1n, username: "user1", email: "user1@example.com", age: 25 },
  { id: 2n, username: "user2", email: "user2@example.com", age: 30 },
];

// 4. Implement a writable buffer to hold the Avro data in memory
class MemoryWritableBuffer implements IWritableBuffer {
  private chunks: Uint8Array[] = [];
  private _isValid = true;

  appendBytes(data: Uint8Array): void {
    if (!this._isValid) {
      throw new Error("Buffer is not valid");
    }
    this.chunks.push(data);
  }

  isValid(): boolean {
    return this._isValid;
  }

  close(): void {
    this._isValid = false;
  }

  getBuffer(): Uint8Array {
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

  // 5. Write user data to an in-memory buffer using AvroWriter
  const memoryBuffer = new MemoryWritableBuffer();
  const writer = AvroWriter.toBuffer(memoryBuffer, { schema: userType });

  for (const user of users) {
    await writer.append(user);
  }
  await writer.close();

  const avroBuffer = memoryBuffer.getBuffer();

  // 6. Use AvroReader to parse the data and log it to the console
  const reader = AvroReader.fromBuffer(avroBuffer.buffer);
  
  let outputText = "Avro data written to and read from in-memory buffer:\n\n";
  for await (const record of reader.iterRecords()) {
    outputText += JSON.stringify(record, (key, value) => 
      typeof value === 'bigint' ? value.toString() + 'n' : value, 2) + '\n';
  }
  await reader.close();

  outputElement.textContent = outputText;
}

const runButton = document.getElementById("run-button");
if (runButton) {
  runButton.addEventListener("click", runExample);
}
