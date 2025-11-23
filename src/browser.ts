import { createType, AvroReader, AvroWriter, InMemoryReadableBuffer } from "@sachitv/avro-typescript";
import { InfiniteInMemoryBuffer } from "./buffer";
import { schema, users } from "./shared";

// 2. Create a Type from the schema
const userType = createType(schema);



async function runExample() {
  const outputElement = document.getElementById("output");
  if (!outputElement) {
    console.error("Output element not found");
    return;
  }

  outputElement.textContent = "Running...";

  // 5. Write user data to an in-memory buffer using AvroWriter
  const memoryBuffer = new InfiniteInMemoryBuffer();
  const writer = AvroWriter.toBuffer(memoryBuffer, { schema: userType });

  for (const user of users) {
    await writer.append(user);
  }
  await writer.close();

  const avroBuffer = memoryBuffer.getBuffer();
  console.log(`Data written to in-memory buffer: ${users.length} records.`);
  console.log(`Avro buffer size: ${avroBuffer.length} bytes.`);
  
  // 6. Use AvroReader to parse the data and log it to the console
  const reader = AvroReader.fromBuffer(new InMemoryReadableBuffer(avroBuffer.buffer as ArrayBuffer));
  
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
