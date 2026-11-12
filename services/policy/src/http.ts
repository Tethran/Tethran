import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ServiceError, type PolicyService } from "./service";

// Thin node:http layer over the service. JSON in, JSON out. No framework.

export const MAX_BODY_BYTES = 256 * 1024;

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...extra });
  res.end(text);
}

class BodyTooLarge extends Error {}
class BadJson extends Error {}

// Reads the body up to the limit. Over the limit it keeps draining (stores nothing) and then throws.
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("error", () => reject(new BadJson()));
    req.on("end", () => {
      if (tooLarge) return reject(new BodyTooLarge());
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new BadJson());
      }
    });
  });
}

type Handler = (url: URL, req: IncomingMessage, match: RegExpMatchArray) => Promise<unknown> | unknown;

export function createHttpServer(service: PolicyService): Server {
  const routes: { method: string; path: RegExp; handler: Handler }[] = [
    { method: "POST", path: /^\/v1\/proposals$/, handler: async (_u, req) => service.submitProposal(await readJson(req)) },
    { method: "GET", path: /^\/v1\/policy$/, handler: () => service.getPolicy() },
    { method: "POST", path: /^\/v1\/policy$/, handler: async (_u, req) => service.setPolicy(await readJson(req)) },
    { method: "GET", path: /^\/v1\/approvals$/, handler: (u) => service.listApprovals(u.searchParams.get("status") ?? "pending") },
    {
      method: "POST",
      path: /^\/v1\/approvals\/([^/]+)\/decision$/,
      handler: async (_u, req, m) => service.decideApproval(decodeURIComponent(m[1]), await readJson(req)),
    },
    { method: "POST", path: /^\/v1\/attestations\/verify$/, handler: async (_u, req) => service.verifyAttestation(await readJson(req)) },
    { method: "GET", path: /^\/v1\/audit$/, handler: (u) => service.getAudit(u.searchParams.get("milestone_id") ?? undefined) },
  ];

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const matching = routes.filter((r) => r.path.test(url.pathname));
      if (matching.length === 0) return send(res, 404, { error: "not found" });
      const route = matching.find((r) => r.method === req.method);
      if (route === undefined) {
        return send(res, 405, { error: "method not allowed" }, { allow: matching.map((r) => r.method).join(", ") });
      }
      const result = await route.handler(url, req, url.pathname.match(route.path) as RegExpMatchArray);
      send(res, 200, result);
    } catch (e) {
      if (e instanceof BodyTooLarge) return send(res, 413, { error: "body too large" });
      if (e instanceof BadJson) return send(res, 400, { error: "malformed JSON" });
      if (e instanceof ServiceError) return send(res, e.status, { error: e.message });
      send(res, 500, { error: "internal error" }); // never echo unknown errors
    }
  });
}

export function listen(server: Server, port: number, host = "127.0.0.1"): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
}
