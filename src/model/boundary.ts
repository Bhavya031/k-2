import type { AppConfig } from "../config.ts";

export type JsonSchema = Readonly<Record<string, unknown>>;

export type ValidationIssue = Readonly<{ path: string; message: string }>;
export type SchemaResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; errors: readonly ValidationIssue[] }>;

/** Runtime schema used at the only model-output boundary. */
export type StructuredSchema<T> = Readonly<{
  name: string;
  jsonSchema: JsonSchema;
  validate(value: unknown): SchemaResult<T>;
}>;

export type LabelledImage = Readonly<{
  label: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  bytes: Uint8Array;
}>;

export type StructuredRequest = Readonly<{
  prompt: string;
  images?: readonly LabelledImage[];
  schema: StructuredSchema<unknown>;
  /** Validation feedback for a repair attempt, never model prose to parse. */
  validationErrors?: readonly ValidationIssue[];
}>;

/** Providers yield only structured candidate data; raw transport responses stay private. */
export interface StructuredProvider {
  request(request: StructuredRequest): Promise<Readonly<{ data: unknown }>>;
}

export type Attempt = Readonly<
  | { number: number; kind: "validation_failure"; errors: readonly ValidationIssue[] }
  | { number: number; kind: "provider_failure"; error: unknown }
  | { number: number; kind: "success" }
>;

export type BoundaryResult<T> =
  | Readonly<{ ok: true; value: T; attempts: readonly Attempt[]; validationErrors: readonly ValidationIssue[] }>
  | Readonly<{ ok: false; attempts: readonly Attempt[]; validationErrors: readonly ValidationIssue[]; error: unknown }>;

function frozenErrors(errors: readonly ValidationIssue[]): readonly ValidationIssue[] {
  return Object.freeze(errors.map((error) => Object.freeze({ ...error })));
}

/**
 * The sole entry point for model calls. Only schema validation failures receive
 * a bounded retry; transport, timeout, rate-limit, and all other errors return
 * immediately to the caller with their attempt record.
 */
export async function askStructured<T>(
  provider: StructuredProvider,
  request: Omit<StructuredRequest, "schema"> & { schema: StructuredSchema<T> },
  maxAttempts = 3,
): Promise<BoundaryResult<T>> {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive safe integer");
  }

  const attempts: Attempt[] = [];
  const validationErrors: ValidationIssue[] = [];
  for (let number = 1; number <= maxAttempts; number += 1) {
    try {
      const response = await provider.request({
        ...request,
        ...(validationErrors.length === 0
          ? {}
          : { validationErrors: frozenErrors(validationErrors) }),
      });
      const validated = request.schema.validate(response.data);
      if (validated.ok) {
        attempts.push(Object.freeze({ number, kind: "success" }));
        return Object.freeze({
          ok: true,
          value: validated.value,
          attempts: Object.freeze(attempts),
          validationErrors: frozenErrors(validationErrors),
        });
      }

      const errors = frozenErrors(validated.errors);
      validationErrors.push(...errors);
      attempts.push(Object.freeze({ number, kind: "validation_failure", errors }));
    } catch (error) {
      attempts.push(Object.freeze({ number, kind: "provider_failure", error }));
      return Object.freeze({
        ok: false,
        attempts: Object.freeze(attempts),
        validationErrors: frozenErrors(validationErrors),
        error,
      });
    }
  }

  return Object.freeze({
    ok: false,
    attempts: Object.freeze(attempts),
    validationErrors: frozenErrors(validationErrors),
    error: new Error(`Model response failed schema validation after ${maxAttempts} attempts`),
  });
}

export type AnthropicFetch = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

export class AnthropicProvider implements StructuredProvider {
  constructor(
    private readonly options: Readonly<{ apiKey: string; model: string; fetch?: AnthropicFetch }>,
  ) {}

  async request(request: StructuredRequest): Promise<Readonly<{ data: unknown }>> {
    const fetchImplementation = this.options.fetch ?? fetch;
    const content: unknown[] = [
      { type: "text", text: request.prompt },
      ...(request.images ?? []).flatMap((image) => [
        { type: "text", text: `Image label: ${image.label}` },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: image.mediaType,
            data: Buffer.from(image.bytes).toString("base64"),
          },
        },
      ]),
    ];
    const repair = request.validationErrors === undefined
      ? ""
      : ` Correct the previous structured output using these validation errors: ${JSON.stringify(request.validationErrors)}.`;
    const response = await fetchImplementation("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.options.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.options.model,
        max_tokens: 1024,
        system: `Return the answer only through the ${request.schema.name} tool.${repair}`,
        messages: [{ role: "user", content }],
        tools: [{
          name: request.schema.name,
          description: "Structured extraction result",
          input_schema: request.schema.jsonSchema,
        }],
        tool_choice: { type: "tool", name: request.schema.name },
      }),
    });
    if (!response.ok) {
      throw new Error(`Anthropic request failed with status ${response.status}`);
    }
    const body = await response.json() as { content?: Array<{ type?: string; name?: string; input?: unknown }> };
    const toolUse = body.content?.find((block) => block.type === "tool_use" && block.name === request.schema.name);
    if (toolUse === undefined || toolUse.input === undefined) {
      throw new Error("Anthropic response did not contain the required tool input");
    }
    return Object.freeze({ data: toolUse.input });
  }
}

export type LocalExecutor = (input: Readonly<{ prompt: string; images: readonly LabelledImage[]; schema: JsonSchema; validationErrors?: readonly ValidationIssue[] }>) => Promise<unknown>;

export async function runLocalBinary(command: string, input: Parameters<LocalExecutor>[0]): Promise<unknown> {
  const result = Bun.spawnSync({
    cmd: [command],
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Local model command failed with exit code ${result.exitCode}: ${new TextDecoder().decode(result.stderr)}`);
  }
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

export class LocalProvider implements StructuredProvider {
  constructor(private readonly command: string, private readonly execute: LocalExecutor = (input) => runLocalBinary(command, input)) {}

  async request(request: StructuredRequest): Promise<Readonly<{ data: unknown }>> {
    return Object.freeze({
      data: await this.execute({
        prompt: request.prompt,
        images: request.images ?? [],
        schema: request.schema.jsonSchema,
        ...(request.validationErrors === undefined ? {} : { validationErrors: request.validationErrors }),
      }),
    });
  }
}

/** Test fixture provider. It is never selected by configuration. */
export class DeterministicMockProvider implements StructuredProvider {
  public calls = 0;
  constructor(private readonly data: unknown) {}
  async request(): Promise<Readonly<{ data: unknown }>> {
    this.calls += 1;
    return Object.freeze({ data: this.data });
  }
}

export type ProviderFactories = Readonly<{
  anthropic(options: Readonly<{ apiKey: string; model: string }>): StructuredProvider;
  local(command: string): StructuredProvider;
}>;

const defaultFactories: ProviderFactories = Object.freeze({
  anthropic: (options) => new AnthropicProvider(options),
  local: (command) => new LocalProvider(command),
});

/** Selects real providers only. There is intentionally no mock branch or mock factory. */
export function createConfiguredProvider(
  config: AppConfig,
  factories: ProviderFactories = defaultFactories,
): StructuredProvider {
  if (config.model.provider === "anthropic") {
    return factories.anthropic({
      apiKey: config.model.apiKey,
      model: config.boundaryModel ?? config.model.modelName,
    });
  }
  if (config.model.command === undefined) {
    throw new Error("Configuration error: LOCAL_MODEL_COMMAND is required for local model inference");
  }
  return factories.local(config.model.command);
}
