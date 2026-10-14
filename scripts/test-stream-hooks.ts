import assert from "node:assert/strict";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { streamAntigravity } from "../src/stream/stream.js";

const originalFetch = globalThis.fetch;
let capturedPayload: unknown = null;
let capturedResponse: { status: number; headers: Record<string, string> } | null = null;
let sentBody: string | undefined;

globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
  if (init?.method === "HEAD") return new Response(null);
  sentBody = typeof init?.body === "string" ? init.body : undefined;
  return new Response("data: [DONE]\n\n", {
    status: 200,
    headers: { "x-test-header": "test-val" },
  });
};

try {
  const model: Model<Api> = {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    provider: "antigravity",
    api: "antigravity-api" as unknown as Api,
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  };
  const context: Context = {
    messages: [{ role: "user", content: "hello" }],
  };

  const stream = streamAntigravity(model, context, {
    apiKey: JSON.stringify({ token: "test-token", projectId: "test-proj" }),
    onPayload: async (payload) => {
      capturedPayload = payload;
      return { ...(payload as Record<string, unknown>), transformed: true };
    },
    onResponse: async (response) => {
      capturedResponse = response;
    },
  });

  for await (const _ of stream) {
    // drain stream
  }

  assert.ok(capturedPayload, "onPayload hook must be called with request payload");
  assert.ok(capturedResponse, "onResponse hook must be called with response");
  assert.equal(capturedResponse?.status, 200);
  assert.equal(capturedResponse?.headers["x-test-header"], "test-val");
  assert.ok(sentBody, "request body must be sent");
  const parsed = JSON.parse(sentBody!) as { transformed?: boolean };
  assert.equal(parsed.transformed, true, "onPayload transformation must be reflected in request body");

  console.log("stream hooks: onPayload and onResponse passed");
} finally {
  globalThis.fetch = originalFetch;
}
