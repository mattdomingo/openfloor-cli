import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiClient } from "../src/client.js";
import { OpenFloorError } from "../src/errors.js";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;
const servers: Array<ReturnType<typeof createServer>> = [];

async function serve(handler: Handler): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

describe("ApiClient", () => {
  it("accepts 204 mutation responses as empty records", async () => {
    const base = await serve((_request, response) => { response.writeHead(204).end(); });
    await expect(new ApiClient(base).request("/empty", { method: "POST", schema: z.object({}).passthrough() })).resolves.toEqual({});
  });

  it("retries transient reads but never mutations", async () => {
    let reads = 0;
    let writes = 0;
    const base = await serve((request, response) => {
      if (request.method === "GET") {
        reads += 1;
        if (reads < 3) { response.writeHead(503, { "content-type": "application/json", "retry-after": "0" }).end('{"error":"later"}'); return; }
        response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'); return;
      }
      writes += 1;
      response.writeHead(503, { "content-type": "application/json" }).end('{"error":"later"}');
    });
    await expect(new ApiClient(base).request("/read")).resolves.toEqual({ ok: true });
    expect(reads).toBe(3);
    await expect(new ApiClient(base).request("/write", { method: "POST", body: {} })).rejects.toMatchObject({ status: 503 });
    expect(writes).toBe(1);
  });

  it("turns redirects, malformed JSON, and contract drift into typed errors", async () => {
    const base = await serve((request, response) => {
      if (request.url === "/redirect") response.writeHead(302, { location: "/cdn-cgi/access/login" }).end();
      else if (request.url === "/html") response.writeHead(200, { "content-type": "text/html" }).end("<html></html>");
      else response.writeHead(200, { "content-type": "application/json" }).end('{"wrong":true}');
    });
    await expect(new ApiClient(base).request("/redirect")).rejects.toMatchObject({ code: "authentication" });
    await expect(new ApiClient(base).request("/html")).rejects.toMatchObject({ code: "invalid_response" });
    await expect(new ApiClient(base).request("/contract", { schema: z.object({ id: z.string() }) })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("bounds responses", async () => {
    const base = await serve((_request, response) => { response.writeHead(200, { "content-length": String(33 * 1024 * 1024) }).end(); });
    await expect(new ApiClient(base).request("/large")).rejects.toBeInstanceOf(OpenFloorError);
  });
});
