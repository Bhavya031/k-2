import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config.ts";
import {
  AnthropicProvider,
  DeterministicMockProvider,
  LocalProvider,
  askStructured,
  createConfiguredProvider,
  runLocalBinary,
  type StructuredProvider,
  type StructuredSchema,
  type ValidationIssue,
} from "../src/model/boundary.ts";

const syntheticSchema: StructuredSchema<Readonly<{ category: "synthetic-delivery" }>> = {
  name: "synthetic_document_result",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["category"],
    properties: { category: { const: "synthetic-delivery" } },
  },
  validate(value) {
    return typeof value === "object" && value !== null && (value as { category?: unknown }).category === "synthetic-delivery"
      ? { ok: true, value: Object.freeze({ category: "synthetic-delivery" as const }) }
      : { ok: false, errors: [{ path: "category", message: "must be the visibly synthetic category" }] };
  },
};

const prompt = "Classify this visibly synthetic delivery document.";

function sequenceProvider(...values: Array<unknown | Error>): StructuredProvider {
  let index = 0;
  return {
    async request() {
      const value = values[index++];
      if (value instanceof Error) throw value;
      return { data: value };
    },
  };
}

describe("askStructured", () => {
  test("retries only invalid structured data, feeding each validation error into the next attempt", async () => {
    const requests: Array<readonly ValidationIssue[] | undefined> = [];
    const provider: StructuredProvider = {
      async request(request) {
        requests.push(request.validationErrors);
        return { data: requests.length === 1 ? { category: "wrong" } : { category: "synthetic-delivery" } };
      },
    };

    const result = await askStructured(provider, { prompt, schema: syntheticSchema }, 2);

    expect(result).toMatchObject({ ok: true, value: { category: "synthetic-delivery" } });
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({ kind: "validation_failure", number: 1 });
    expect(result.validationErrors).toEqual([{ path: "category", message: "must be the visibly synthetic category" }]);
    expect(requests[0]).toBeUndefined();
    expect(requests[1]).toEqual(result.validationErrors);
  });

  test("fails loudly after bounded invalid responses with all attempts and validation errors", async () => {
    const result = await askStructured(sequenceProvider({ category: "wrong" }, { category: "still-wrong" }), { prompt, schema: syntheticSchema }, 2);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as Error).message).toContain("after 2 attempts");
      expect(result.attempts).toHaveLength(2);
      expect(result.validationErrors).toHaveLength(2);
      expect(result.attempts.every((attempt) => attempt.kind === "validation_failure")).toBe(true);
    }
  });

  test.each([new Error("rate limit"), new Error("timeout")])("does not retry a provider failure: %s", async (failure) => {
    const result = await askStructured(sequenceProvider(failure, { category: "synthetic-delivery" }), { prompt, schema: syntheticSchema }, 3);

    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ kind: "provider_failure", number: 1 });
    expect(result.validationErrors).toEqual([]);
  });
});

describe("local model binary", () => {
  test("includes the local command stderr when the process fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "k2-local-model-error-"));
    const command = join(directory, "synthetic-failing-command");
    try {
      await writeFile(command, "#!/bin/sh\necho synthetic-local-diagnostic >&2\nexit 7\n");
      await chmod(command, 0o755);
      await expect(runLocalBinary(command, { prompt: "synthetic prompt", images: [], schema: { type: "object" } })).rejects
        .toThrow("Local model command failed with exit code 7: synthetic-local-diagnostic");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("providers", () => {
  test("Anthropic request visibly forces tool-schema output without a network call", async () => {
    let captured: RequestInit | undefined;
    const provider = new AnthropicProvider({
      apiKey: "synthetic-api-key",
      model: "configured-synthetic-model",
      fetch: async (_url, init) => {
        captured = init;
        return new Response(JSON.stringify({ content: [{ type: "tool_use", name: syntheticSchema.name, input: { category: "synthetic-delivery" } }] }), { status: 200 });
      },
    });

    const response = await provider.request({ prompt, schema: syntheticSchema, images: [{ label: "synthetic-page-1", mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) }] });
    const body = JSON.parse(String(captured?.body));

    expect(response).toEqual({ data: { category: "synthetic-delivery" } });
    expect(body.model).toBe("configured-synthetic-model");
    expect(body.tools[0].input_schema).toEqual(syntheticSchema.jsonSchema);
    expect(body.tool_choice).toEqual({ type: "tool", name: syntheticSchema.name });
    expect(body.messages[0].content).toContainEqual({ type: "text", text: "Image label: synthetic-page-1" });
  });

  test("local provider returns the same structured-data shape", async () => {
    let inputSchema: unknown;
    const provider = new LocalProvider("synthetic-local-binary", async (input) => {
      inputSchema = input.schema;
      return { category: "synthetic-delivery" };
    });

    expect(await provider.request({ prompt, schema: syntheticSchema })).toEqual({ data: { category: "synthetic-delivery" } });
    expect(inputSchema).toEqual(syntheticSchema.jsonSchema);
  });

  test("a real configuration cannot acquire or call the test-only mock and applies BOUNDARY_MODEL", async () => {
    const mock = new DeterministicMockProvider({ category: "mock" });
    let configuredModel: string | undefined;
    const provider = createConfiguredProvider(loadConfig({
      DATABASE_PATH: "/tmp/synthetic.sqlite",
      MODEL_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "synthetic-api-key",
      ANTHROPIC_MODEL: "configured-default-model",
      BOUNDARY_MODEL: "configured-boundary-model",
    }), {
      anthropic: ({ model }) => {
        configuredModel = model;
        return sequenceProvider({ category: "synthetic-delivery" });
      },
      local: () => { throw new Error("local must not be acquired"); },
    });

    const result = await askStructured(provider, { prompt, schema: syntheticSchema });
    expect(result.ok).toBe(true);
    expect(configuredModel).toBe("configured-boundary-model");
    expect(mock.calls).toBe(0);
  });

  test("a configured local provider cannot acquire or call the test-only mock", async () => {
    const mock = new DeterministicMockProvider({ category: "mock" });
    let configuredCommand: string | undefined;
    const provider = createConfiguredProvider(loadConfig({
      DATABASE_PATH: "/tmp/synthetic.sqlite",
      MODEL_PROVIDER: "local",
      LOCAL_MODEL_COMMAND: "synthetic-local-binary",
    }), {
      anthropic: () => { throw new Error("Anthropic must not be acquired"); },
      local: (command) => {
        configuredCommand = command;
        return sequenceProvider({ category: "synthetic-delivery" });
      },
    });

    expect((await askStructured(provider, { prompt, schema: syntheticSchema })).ok).toBe(true);
    expect(configuredCommand).toBe("synthetic-local-binary");
    expect(mock.calls).toBe(0);
  });
});
