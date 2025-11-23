
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

  getBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

async function main() {
  console.log("Running Avro TypeScript example...");

  // 5. Write user data to an in-memory buffer using AvroWriter
  const memoryBuffer = new MemoryWritableBuffer();
  const writer = AvroWriter.toBuffer(memoryBuffer, { schema: userType });

  for (const user of users) {
    await writer.append(user);
  }
  await writer.close();
  console.log("Data written to in-memory buffer.");

  // 6. Save the in-memory buffer to an Avro file
  const avroBuffer = memoryBuffer.getBuffer();
  const filePath = "users.avro";
  await Bun.write(filePath, avroBuffer);
  console.log(`In-memory buffer saved to ${filePath}`);

  // 7. Read the Avro file back into a buffer
  const fileContent = await Bun.file(filePath).arrayBuffer();
  console.log(`${filePath} read back into a buffer.`);

  // 8. Use AvroReader to parse the data and log it to the console
  const reader = AvroReader.fromBuffer(fileContent);
  console.log("Reading records from Avro file:");
  for await (const record of reader.iterRecords()) {
    console.log(record);
  }
  await reader.close();

  console.log("Example finished.");
}

main().catch(console.error);
