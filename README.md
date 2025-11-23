# Bun Avro TypeScript Example

This project demonstrates how to use the `@sachitv/avro-typescript` library with Bun to write and read Avro files.

## Setup

Install the dependencies:

```bash
bun install
```

## Running the Node.js Example

To run the Node.js example, execute the following command:

```bash
bun run index.ts
```

This will:
1.  Define an Avro schema for a `User`.
2.  Write user data to an in-memory buffer.
3.  Save the buffer to a file named `users.avro`.
4.  Read the `users.avro` file.
5.  Parse the Avro data and log the records to the console.

## Running the Browser Example

This project also includes a browser-based example.

### 1. Build the browser bundle

```bash
bun build ./browser.ts --outdir ./dist
```

### 2. Start the server

```bash
bun start
```

### 3. Open the example

Open your browser and navigate to [http://localhost:3000](http://localhost:3000).

Click the "Run Avro Example" button to see the library in action. The example will write and read Avro data entirely in your browser.