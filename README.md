# Bun Avro TypeScript Example

This project demonstrates how to use the `@sachitv/avro-typescript` library with Bun to write and read Avro files.

## Setup

Install the dependencies:

```bash
bun install
```

## Running the Example

To run the example, execute the following command:

```bash
bun run index.ts
```

This will:
1.  Define an Avro schema for a `User`.
2.  Write user data to an in-memory buffer.
3.  Save the buffer to a file named `users.avro`.
4.  Read the `users.avro` file.
5.  Parse the Avro data and log the records to the console.