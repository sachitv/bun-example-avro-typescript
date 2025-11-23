// Shared data for Avro example
export const schema = {
  type: "record",
  name: "User",
  fields: [
    { name: "id", type: "long" },
    { name: "username", type: "string" },
    { name: "email", type: "string" },
    { name: "age", type: "int" },
  ],
};

export const users = [
  { id: 1n, username: "user1", email: "user1@example.com", age: 25 },
  { id: 2n, username: "user2", email: "user2@example.com", age: 30 },
];