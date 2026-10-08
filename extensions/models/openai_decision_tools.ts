/**
 * Agent-facing judgments over supplied text or bounded repository files.
 * Uses OpenAI Decisions directly; does not execute tools or depend on Jev.
 * @module
 */
import { z } from "npm:zod@4";
import { isAbsolute, join, relative } from "node:path";

const MODEL = "gpt-6-luna";
const ENDPOINT = "https://api.openai.com/v1/decisions";
const MAX_FILES = 20;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 192 * 1024;
const MAX_REQUEST_BYTES = 240 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_WALK_ENTRIES = 10_000;
const MAX_WALK_DEPTH = 12;
const NameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const InstructionsSchema = z.string().min(1).max(2_000);
const ValueSchema = z.union([z.string().min(1).max(512), z.boolean()]);
const ProbabilitySchema = z.number().finite().min(0).max(1);
const QuestionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    name: NameSchema,
    type: z.literal("predicate"),
    instructions: InstructionsSchema,
  }),
  z.strictObject({
    name: NameSchema,
    type: z.literal("choice"),
    instructions: InstructionsSchema,
    choices: z.array(z.strictObject({
      value: ValueSchema,
      description: z.string().max(1_000).optional(),
    })).min(2).max(255),
  }),
  z.strictObject({
    name: NameSchema,
    type: z.literal("score"),
    instructions: InstructionsSchema,
    levels: z.array(z.strictObject({
      label: z.string().min(1).max(512),
      description: z.string().max(1_000).optional(),
    })).min(2).max(10),
  }),
]);
const QuestionsSchema = z.array(QuestionSchema).min(1).max(32).superRefine(
  (questions, ctx) => {
    const names = new Set<string>();
    for (const question of questions) {
      if (names.has(question.name)) {
        ctx.addIssue({
          code: "custom",
          message: "Question names must be unique",
        });
      }
      names.add(question.name);
      const values = question.type === "choice"
        ? question.choices.map(({ value }) => JSON.stringify(value))
        : question.type === "score"
        ? question.levels.map(({ label }) => label)
        : [];
      if (new Set(values).size !== values.length) {
        ctx.addIssue({
          code: "custom",
          message: "Choice values and score labels must be unique",
        });
      }
    }
  },
);
const GlobalArgsSchema = z.object({
  apiKey: z.string().min(1).meta({ sensitive: true }).optional().describe(
    "Vault-backed OpenAI API key. Falls back to OPENAI_API_KEY when omitted.",
  ),
  repositoryRoot: z.string().min(1).optional().describe(
    "Absolute checkout path required for askFiles; file selectors are relative to this root.",
  ),
  concurrency: z.number().int().min(1).max(8).default(4).describe(
    "Maximum simultaneous HTTP requests in per-file mode, within one model invocation.",
  ),
});
// Swamp merges global arguments into this object; strip them before execution.
const AskArgsSchema = z.object({
  input: z.string().min(1).describe("Text evidence shared by every question."),
  questions: QuestionsSchema,
});
const AskFilesArgsSchema = z.object({
  input: z.string().default("").describe(
    "Task context supplied alongside the selected files.",
  ),
  questions: QuestionsSchema,
  paths: z.array(z.string().min(1).max(512)).max(100).default([]),
  globs: z.array(z.string().min(1).max(512)).max(100).default([]).describe(
    "Repository-relative patterns supporting *, **, and ?; for example src/**/*.ts.",
  ),
  mode: z.enum(["combined", "per-file"]).default("per-file"),
}).refine((args) => args.paths.length + args.globs.length > 0, {
  message: "askFiles requires at least one path or glob",
}).refine((args) => args.paths.length + args.globs.length <= 100, {
  message: "At most 100 paths and globs may be supplied",
});
const AnswerSchema = z.discriminatedUnion("type", [
  z.object({
    name: NameSchema,
    type: z.literal("predicate"),
    probability: ProbabilitySchema,
  }),
  z.object({
    name: NameSchema,
    type: z.literal("choice"),
    choice: ValueSchema,
    confidence: ProbabilitySchema,
    probabilities: z.array(
      z.object({ value: ValueSchema, probability: ProbabilitySchema }),
    ),
  }),
  z.object({
    name: NameSchema,
    type: z.literal("score"),
    score: z.number().finite().nonnegative(),
    confidence: ProbabilitySchema,
    probabilities: z.array(z.object({
      label: z.string(),
      value: z.number().int().nonnegative(),
      probability: ProbabilitySchema,
    })),
  }),
  z.object({ name: NameSchema, type: z.literal("refusal") }),
]);
const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});
const ResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.array(AnswerSchema),
  usage: UsageSchema,
});
const EvaluationSchema = ResponseSchema.extend({
  path: z.string().optional(),
  durationMs: z.number().nonnegative(),
});
const FileMetadataSchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const SkippedSchema = z.object({ path: z.string(), reason: z.string() });
const ResultSchema = z.object({
  mode: z.enum(["combined", "per-file"]),
  evaluations: z.array(EvaluationSchema).min(1),
  files: z.array(FileMetadataSchema),
  skipped: z.array(SkippedSchema),
  truncated: z.boolean(),
  requestCount: z.number().int().positive(),
  refusalCount: z.number().int().nonnegative(),
  usage: UsageSchema,
  durationMs: z.number().nonnegative(),
  evaluatedAt: z.iso.datetime(),
});
type Questions = z.infer<typeof QuestionsSchema>;
type Evaluation = z.infer<typeof EvaluationSchema>;
type SelectedFile = z.infer<typeof FileMetadataSchema> & { text: string };
type Selection = {
  files: SelectedFile[];
  skipped: z.infer<typeof SkippedSchema>[];
  truncated: boolean;
};
type Context = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  signal?: AbortSignal;
  logger: { info: (event: string, fields: Record<string, unknown>) => void };
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
};

function excluded(path: string): boolean {
  return path.split(/[\\/]/).some((part) =>
    part.startsWith(".") ||
    /^(node_modules|secrets?|credentials?)$/i.test(part) ||
    /(^|[._-])(secrets?|credentials?|private[-_]?key)([._-]|$)/i.test(part) ||
    /\.(pem|key|p12|pfx|keystore)$/i.test(part)
  );
}

function selectorError(path: string): string | undefined {
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.includes("\0")) {
    return "not a relative repository path";
  }
  if (path.replaceAll("\\", "/").split("/").includes("..")) {
    return "parent traversal is not allowed";
  }
  if (excluded(path)) return "excluded hidden or sensitive path";
}

function globRegex(pattern: string): RegExp {
  let result = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        i++;
        result += "(?:.*/)?";
      } else result += ".*";
    } else if (char === "*") result += "[^/]*";
    else if (char === "?") result += "[^/]";
    else result += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${result}$`);
}

async function selectFiles(
  rootPath: string | undefined,
  paths: string[],
  patterns: string[],
  signal?: AbortSignal,
): Promise<Selection> {
  if (!rootPath || !isAbsolute(rootPath)) {
    throw new Error(
      "askFiles requires an absolute repositoryRoot global argument",
    );
  }
  const root = await Deno.realPath(rootPath);
  const selection: Selection = { files: [], skipped: [], truncated: false };
  const requested = new Set<string>();
  const globs: RegExp[] = [];
  for (
    const [selectors, isGlob] of [[paths, false], [patterns, true]] as const
  ) {
    for (const selector of selectors) {
      const reason = selectorError(selector);
      if (reason) selection.skipped.push({ path: selector, reason });
      else if (isGlob) globs.push(globRegex(selector.replaceAll("\\", "/")));
      else requested.add(selector.replaceAll("\\", "/"));
    }
  }
  let visited = 0;
  async function walk(
    directory: string,
    prefix: string,
    depth: number,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (depth > MAX_WALK_DEPTH) {
      selection.truncated = true;
      selection.skipped.push({
        path: prefix,
        reason: "directory recursion limit reached",
      });
      return;
    }
    for await (const entry of Deno.readDir(directory)) {
      signal?.throwIfAborted();
      if (++visited > MAX_WALK_ENTRIES) {
        throw new Error(
          "Repository walk exceeded the 10000-entry limit; narrow the globs",
        );
      }
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (excluded(path)) continue;
      if (entry.isDirectory) {
        await walk(join(directory, entry.name), path, depth + 1);
      } else if (globs.some((pattern) => pattern.test(path))) {
        requested.add(path);
      }
    }
  }
  if (globs.length) await walk(root, "", 0);
  let total = 0;
  for (const path of [...requested].sort()) {
    signal?.throwIfAborted();
    const skip = (reason: string, truncated = false): void => {
      selection.skipped.push({ path, reason });
      selection.truncated ||= truncated;
    };
    if (selection.files.length >= MAX_FILES) {
      skip("file count limit exceeded", true);
      continue;
    }
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      const candidate = await Deno.realPath(join(root, path));
      const rel = relative(root, candidate);
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
        skip("resolved path escapes repository root");
        continue;
      }
      if (excluded(rel)) {
        skip("resolved path is hidden or sensitive");
        continue;
      }
      const info = await Deno.stat(candidate);
      if (!info.isFile) {
        skip("not a regular file");
        continue;
      }
      if (info.size > MAX_FILE_BYTES || total + info.size > MAX_TOTAL_BYTES) {
        skip("file or total byte limit exceeded", true);
        continue;
      }
      // Read at most the budget plus one byte, even if the file grows after stat.
      const file = await Deno.open(candidate, { read: true });
      try {
        const buffer = new Uint8Array(MAX_FILE_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          signal?.throwIfAborted();
          const count = await file.read(buffer.subarray(length));
          if (count === null) break;
          length += count;
        }
        bytes = buffer.subarray(0, length);
      } finally {
        file.close();
      }
    } catch {
      signal?.throwIfAborted();
      skip("file not found or unreadable");
      continue;
    }
    if (
      bytes.length > MAX_FILE_BYTES || total + bytes.length > MAX_TOTAL_BYTES
    ) {
      skip("file or total byte limit exceeded", true);
      continue;
    }
    if (bytes.includes(0)) {
      skip("binary file");
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      skip("invalid UTF-8");
      continue;
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    selection.files.push({ path, text, bytes: bytes.length, sha256 });
    total += bytes.length;
  }
  if (!selection.files.length) {
    throw new Error("askFiles selected no readable text files");
  }
  return selection;
}

function validateResponse(
  raw: unknown,
  questions: Questions,
): z.infer<typeof ResponseSchema> {
  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("OpenAI Decisions returned a malformed response");
  }
  const response = parsed.data;
  const byName = new Map(
    response.answers.map((answer) => [answer.name, answer]),
  );
  if (
    response.answers.length !== questions.length ||
    byName.size !== questions.length
  ) {
    throw new Error(
      "OpenAI Decisions returned missing, extra, or duplicate answers",
    );
  }
  const answers = questions.map((question) => {
    const answer = byName.get(question.name);
    if (!answer) {
      throw new Error("OpenAI Decisions returned unknown question names");
    }
    if (answer.type === "refusal") return answer;
    if (answer.type !== question.type) {
      throw new Error("OpenAI Decisions returned a wrong answer type");
    }
    if (answer.type === "choice" && question.type === "choice") {
      const expected = new Set(
        question.choices.map(({ value }) => JSON.stringify(value)),
      );
      const actual = answer.probabilities.map(({ value }) =>
        JSON.stringify(value)
      );
      if (
        !expected.has(JSON.stringify(answer.choice)) ||
        actual.length !== expected.size ||
        new Set(actual).size !== expected.size || actual.some((value) =>
          !expected.has(value)
        )
      ) {
        throw new Error(
          "OpenAI Decisions returned invalid choice values or probabilities",
        );
      }
    }
    if (answer.type === "score" && question.type === "score") {
      const indices = new Set<number>();
      if (
        answer.score > question.levels.length - 1 ||
        answer.probabilities.length !== question.levels.length ||
        answer.probabilities.some(({ label, value }) => {
          if (
            indices.has(value) || question.levels[value]?.label !== label
          ) return true;
          indices.add(value);
          return false;
        })
      ) {
        throw new Error(
          "OpenAI Decisions returned invalid score levels or probabilities",
        );
      }
      const weighted = answer.probabilities.reduce(
        (sum, level) => sum + level.value * level.probability,
        0,
      );
      if (Math.abs(weighted - answer.score) > 0.01) {
        throw new Error(
          "OpenAI Decisions score does not match its probability distribution",
        );
      }
    }
    if (answer.type === "choice" || answer.type === "score") {
      const total = answer.probabilities.reduce(
        (sum, item) => sum + item.probability,
        0,
      );
      if (Math.abs(total - 1) > 0.01) {
        throw new Error("OpenAI Decisions probabilities do not sum to one");
      }
    }
    return answer;
  });
  return { ...response, answers };
}

function requestBody(input: string, questions: Questions): string {
  const body = JSON.stringify({ model: MODEL, input, questions });
  if (new TextEncoder().encode(body).length > MAX_REQUEST_BYTES) {
    throw new Error("OpenAI Decisions request exceeds the 240-KiB budget");
  }
  return body;
}

async function evaluate(
  body: string,
  questions: Questions,
  context: Context,
  signal?: AbortSignal,
): Promise<Evaluation> {
  const started = performance.now();
  signal?.throwIfAborted();
  const apiKey = context.globalArgs.apiKey ?? Deno.env.get("OPENAI_API_KEY");
  if (!apiKey || apiKey.includes("${{")) {
    throw new Error(
      "Configure a resolved vault-backed apiKey or OPENAI_API_KEY before calling Decisions",
    );
  }
  const timeout = AbortSignal.timeout(30_000);
  const requestSignal = AbortSignal.any([timeout, ...(signal ? [signal] : [])]);
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      signal: requestSignal,
      redirect: "error",
    });
  } catch {
    if (signal?.aborted) throw new Error("OpenAI Decisions request cancelled");
    if (timeout.aborted) {
      throw new Error("OpenAI Decisions request timed out after 30 seconds");
    }
    throw new Error(
      "OpenAI Decisions network request failed; check connectivity and retry explicitly",
    );
  }
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // The body may already be errored; retain the sanitized HTTP failure.
    }
    const retryAfter = response.headers.get("retry-after");
    const retrySeconds = retryAfter && /^\d+(\.\d+)?$/.test(retryAfter)
      ? Number(retryAfter)
      : retryAfter && Number.isFinite(Date.parse(retryAfter))
      ? Math.max(0, (Date.parse(retryAfter) - Date.now()) / 1000)
      : undefined;
    const reason = response.status === 429
      ? retrySeconds === undefined
        ? "rate limited; retry later"
        : `rate limited; retry after ${Math.ceil(retrySeconds)} seconds`
      : response.status === 401 || response.status === 403
      ? "check the API key and project access"
      : response.status >= 500
      ? "provider unavailable; retry later"
      : "check request parameters and endpoint availability";
    // Provider error bodies can echo input or secrets; never persist them in errors.
    throw new Error(`OpenAI Decisions HTTP ${response.status}: ${reason}`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("OpenAI Decisions returned an empty response body");
  }
  let raw: unknown;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      requestSignal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_RESPONSE_BYTES) {
        throw new Error("response budget exceeded");
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    if (signal?.aborted) throw new Error("OpenAI Decisions request cancelled");
    if (timeout.aborted) {
      throw new Error("OpenAI Decisions response timed out after 30 seconds");
    }
    throw new Error(
      "OpenAI Decisions returned invalid, interrupted, or oversized JSON",
    );
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Cancelling an already-errored stream can reject with the same error.
      // Preserve the sanitized failure above instead of exposing that payload.
    } finally {
      reader.releaseLock();
    }
  }
  return {
    ...validateResponse(raw, questions),
    durationMs: performance.now() - started,
  };
}

async function writeResult(
  context: Context,
  started: number,
  mode: "combined" | "per-file",
  evaluations: Evaluation[],
  selection: Selection,
): Promise<{ dataHandles: unknown[] }> {
  context.signal?.throwIfAborted();
  const result = ResultSchema.parse({
    mode,
    evaluations,
    files: selection.files.map(({ path, bytes, sha256 }) => ({
      path,
      bytes,
      sha256,
    })),
    skipped: selection.skipped,
    truncated: selection.truncated,
    requestCount: evaluations.length,
    refusalCount: evaluations.flatMap(({ answers }) =>
      answers
    ).filter(({ type }) => type === "refusal").length,
    usage: evaluations.reduce((sum, item) => ({
      input_tokens: sum.input_tokens + item.usage.input_tokens,
      output_tokens: sum.output_tokens + item.usage.output_tokens,
      total_tokens: sum.total_tokens + item.usage.total_tokens,
    }), { input_tokens: 0, output_tokens: 0, total_tokens: 0 }),
    durationMs: performance.now() - started,
    evaluatedAt: new Date().toISOString(),
  });
  const handle = await context.writeResource(
    "result",
    `result-${crypto.randomUUID()}`,
    result,
  );
  context.logger.info("openai_decisions_completed", {
    request_count: result.requestCount,
    file_count: result.files.length,
    skipped_count: result.skipped.length,
    refusal_count: result.refusalCount,
    duration_ms: result.durationMs,
    input_tokens: result.usage.input_tokens,
  });
  return { dataHandles: [handle] };
}

/** Typed, advisory agent tools backed by OpenAI's dedicated Decisions API. */
export const model = {
  type: "@mgreten/openai-decision-tools",
  version: "2026.10.08.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    result: {
      description:
        "Named typed answers, explicit refusals, source hashes, omissions, usage, and timings. No raw evidence or question instructions.",
      schema: ResultSchema,
      lifetime: "7d" as const,
      garbageCollection: 100,
    },
  },
  methods: {
    ask: {
      description:
        "Ask 1–32 independent predicate, choice, or score questions over supplied text in one OpenAI Decisions request. Returns named answers and probabilities; refusals stay explicit. Use for routing or triaging existing output, not tool execution or authorization.",
      arguments: AskArgsSchema,
      execute: async (
        args: z.input<typeof AskArgsSchema>,
        context: Context,
      ): Promise<{ dataHandles: unknown[] }> => {
        const started = performance.now();
        const parsed = AskArgsSchema.parse(args);
        context.logger.info("openai_decisions_started", {
          mode: "combined",
          question_count: parsed.questions.length,
        });
        const body = requestBody(parsed.input, parsed.questions);
        const evaluation = await evaluate(
          body,
          parsed.questions,
          context,
          context.signal,
        );
        return await writeResult(context, started, "combined", [evaluation], {
          files: [],
          skipped: [],
          truncated: false,
        });
      },
    },
    askFiles: {
      description:
        "Scout explicitly selected repository files without loading source into the calling agent. Supply relative paths/globs and named typed questions. Per-file mode sends separate bounded concurrent requests; combined mode compares files in one request. Returns answers, paths, hashes, and omissions, not source. Read code before editing it; judgments are not authorizations.",
      arguments: AskFilesArgsSchema,
      execute: async (
        args: z.input<typeof AskFilesArgsSchema>,
        context: Context,
      ): Promise<{ dataHandles: unknown[] }> => {
        const started = performance.now();
        const parsed = AskFilesArgsSchema.parse(args);
        context.logger.info("openai_decisions_started", {
          mode: parsed.mode,
          question_count: parsed.questions.length,
        });
        const selection = await selectFiles(
          context.globalArgs.repositoryRoot,
          parsed.paths,
          parsed.globs,
          context.signal,
        );
        const files = selection.files.map(({ path, text }) => ({ path, text }));
        const bodies = parsed.mode === "combined"
          ? [
            requestBody(
              JSON.stringify({ input: parsed.input, files }),
              parsed.questions,
            ),
          ]
          : files.map((file) =>
            requestBody(
              JSON.stringify({ input: parsed.input, file }),
              parsed.questions,
            )
          );
        const evaluations: Evaluation[] = new Array(bodies.length);
        const controller = new AbortController();
        const signal = AbortSignal.any([
          controller.signal,
          ...(context.signal ? [context.signal] : []),
        ]);
        let next = 0;
        let failure: unknown;
        const workers = Array.from({
          length: Math.min(context.globalArgs.concurrency, bodies.length),
        }, async () => {
          while (next < bodies.length && !signal.aborted) {
            const index = next++;
            try {
              const evaluation = await evaluate(
                bodies[index],
                parsed.questions,
                context,
                signal,
              );
              evaluations[index] = parsed.mode === "per-file"
                ? { ...evaluation, path: files[index].path }
                : evaluation;
            } catch (error) {
              failure ??= error;
              controller.abort();
            }
          }
        });
        await Promise.all(workers);
        if (failure) throw failure;
        signal.throwIfAborted();
        return await writeResult(
          context,
          started,
          parsed.mode,
          evaluations,
          selection,
        );
      },
    },
  },
};
