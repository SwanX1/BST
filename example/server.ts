import path from 'node:path';

Bun.serve({
  port: 8080,
  async fetch(request, server) {
    const pathname = path.join('./dist', new URL(request.url).pathname.slice(1));
    const file = Bun.file(pathname);
    if (!await file.exists()) {
      return new Response('Not Found', { status: 404 });
    }
    return new Response(file);
  },
});
