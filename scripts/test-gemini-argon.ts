import assert from "node:assert/strict";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import {
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_PERSIST_KEY,
  ANTIGRAVITY_ROUTING,
  applyAntigravityCatalog,
  buildAntigravityCatalog,
  clearModelEnumCache,
  getAntigravityRequestModelId,
  getFallbackRuntimeModel,
  getModelEnum,
  getThinkingConfig,
  hydrateAntigravityCatalog,
  registerModelEnum,
  resetAntigravityCatalogForTests,
  snapshotDynamicModelEnums,
} from "../src/models/index.js";
import { buildRequest, convertMessages } from "../src/stream/index.js";

const configured = ANTIGRAVITY_MODELS.find((model) => model.id === "gemini-4-argon");
assert.ok(configured, "Argon must be selectable without a refreshed catalog");
assert.equal(configured.contextWindow, 1048576);
assert.equal(configured.maxTokens, 65536, "long decode is not a single streaming request");
assert.deepEqual(configured.input, ["text", "image"]);
assert.deepEqual(configured.cost, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 });
const model: Model<Api> = {
  ...configured,
  api: "antigravity-api",
  provider: "antigravity",
  baseUrl: "https://cloudcode-pa.googleapis.com",
};
const context: Context = { messages: [{ role: "user", content: "Say hello.", timestamp: 0 }] };
const fallback = { models: ANTIGRAVITY_MODELS, routing: ANTIGRAVITY_ROUTING };

try {
  clearModelEnumCache();
  for (const [effort, expectedLevel, includeThoughts] of [
    [undefined, "MEDIUM", true],
    ["off", "LOW", false],
    ["minimal", "LOW", true],
    ["low", "LOW", true],
    ["medium", "MEDIUM", true],
    ["high", "HIGH", true],
    ["xhigh", "HIGH", true],
    ["max", "HIGH", true],
  ] as const) {
    const runtime = getAntigravityRequestModelId(model.id, effort);
    assert.equal(runtime, "gemini-4-argon", "fallback must not invent runtime variants");
    const request = buildRequest(model, context, "test-project", { reasoning: effort }, runtime);
    assert.equal(request.model, runtime);
    assert.deepEqual(request.request.generationConfig?.thinkingConfig, {
      includeThoughts,
      thinkingLevel: expectedLevel,
    });
    assert.equal(request.request.generationConfig?.maxOutputTokens, 65536);
    assert.equal(request.request.labels?.model_enum, undefined, "do not fabricate model enums");
    assert.equal(request.request.labels?.used_non_gemini_model, "false");
    assert.equal(getFallbackRuntimeModel(runtime, effort), undefined, "no silent model downgrade");
  }
  for (const maxTokens of [2048, 65536, 1048576]) {
    const request = buildRequest(model, context, "test-project", { maxTokens }, model.id);
    assert.equal(request.request.generationConfig?.maxOutputTokens, Math.min(maxTokens, 65536));
  }
  const flash = { ...model, id: "gemini-3.8-flash" };
  const overridden = buildRequest(flash, context, "test-project", { reasoning: "high" }, model.id);
  assert.deepEqual(overridden.request.generationConfig?.thinkingConfig, {
    includeThoughts: true,
    thinkingLevel: "HIGH",
  });
  assert.deepEqual(
    getThinkingConfig("gemini-3.8-flash-low", undefined),
    {
      includeThoughts: false,
      thinkingBudget: 0,
    },
    "omitted reasoning keeps existing models' behavior",
  );

  // Hypothetical discovery fixtures: routing must use the server's exact IDs, not guessed aliases.
  const catalog = buildAntigravityCatalog(
    {
      "gemini-4-argon-low": { displayName: "Gemini 4 Argon (Low)", supportsImages: true },
      "gemini-4-argon-medium": { displayName: "Gemini 4 Argon (Medium)", supportsImages: true },
      "gemini-4-argon-agent": { displayName: "Gemini 4 Argon (High)", supportsImages: true },
    },
    fallback,
  );
  applyAntigravityCatalog(catalog);
  const discovered = catalog.models.filter((entry) => entry.id === model.id);
  assert.equal(discovered.length, 1, "runtime variants collapse to one public model");
  assert.equal(discovered[0]?.maxTokens, configured.maxTokens);
  assert.deepEqual(
    discovered[0]?.cost,
    configured.cost,
    "variants retain Argon, not Flash pricing",
  );
  for (const [effort, runtime, level] of [
    ["low", "gemini-4-argon-low", "LOW"],
    ["medium", "gemini-4-argon-medium", "MEDIUM"],
    ["high", "gemini-4-argon-agent", "HIGH"],
  ] as const) {
    assert.equal(getAntigravityRequestModelId(model.id, effort), runtime);
    const request = buildRequest(model, context, "test-project", { reasoning: effort }, runtime);
    assert.deepEqual(request.request.generationConfig?.thinkingConfig, {
      includeThoughts: true,
      thinkingLevel: level,
    });
  }
  registerModelEnum("gemini-4-argon-low", "MODEL_ARGON_TEST_ONLY");
  const stored = {
    [ANTIGRAVITY_PERSIST_KEY]: {
      catalog,
      checkedAt: Date.now(),
      modelEnums: snapshotDynamicModelEnums(),
    },
  };
  resetAntigravityCatalogForTests();
  clearModelEnumCache();
  hydrateAntigravityCatalog(stored);
  assert.equal(getAntigravityRequestModelId(model.id, "high"), "gemini-4-argon-agent");
  assert.equal(getModelEnum(model.id), "MODEL_ARGON_TEST_ONLY");

  const highOnly = buildAntigravityCatalog(
    {
      "gemini-4-argon-high": { displayName: "Gemini 4 Argon (High)", supportsImages: false },
    },
    fallback,
  ).models.find((entry) => entry.id === model.id);
  assert.ok(highOnly);
  assert.deepEqual(highOnly.input, ["text"], "discovered capabilities take precedence");
  assert.deepEqual(
    Object.entries(highOnly.thinkingLevelMap ?? {})
      .filter(([, value]) => value !== null)
      .map(([key]) => key),
    ["high"],
  );
  const unsuffixed = buildAntigravityCatalog(
    {
      "gemini-4-argon": {
        displayName: "Gemini 4 Argon",
        supportsThinking: true,
        supportsImages: true,
      },
    },
    fallback,
  );
  assert.deepEqual(unsuffixed.routing[model.id], ANTIGRAVITY_ROUTING[model.id]);
  assert.deepEqual(
    unsuffixed.models.find((entry) => entry.id === model.id),
    configured,
  );

  const signature = "QkFTRTY0LXRlc3Qtc2lnbmF0dXJlLXRlc3QxMjM0NTY=";
  const toolContext: Context = {
    messages: [
      ...context.messages,
      {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [
          {
            type: "toolCall",
            id: "argon-read",
            name: "read",
            arguments: { path: "README.md" },
            thoughtSignature: signature,
          },
        ],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "argon-read",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "Contents" }],
        timestamp: 2,
      },
    ],
  };
  const contents = convertMessages(model, toolContext, "gemini-4-argon");
  assert.ok(
    contents[1]?.parts.some(
      (part) => "functionCall" in part && part.thoughtSignature === signature,
    ),
  );
  assert.ok(contents[2]?.parts.some((part) => "functionResponse" in part));
} finally {
  resetAntigravityCatalogForTests();
  clearModelEnumCache();
}

console.log(
  "Gemini 4 Argon: fallback, thinking levels, discovery, persistence, and signed tools passed",
);
