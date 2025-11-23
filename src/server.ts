Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);
    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = url.pathname.startsWith("/dist/") ? Bun.file(`.${filePath}`) : Bun.file(`./src${filePath}`);
    if (await file.exists()) {
      return new Response(file);
    }
    return new Response("Not Found", { status: 404 });
  },
});

console.log("Server running at http://localhost:3000");
