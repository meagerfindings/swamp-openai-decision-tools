import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { model } from "./openai_decision_tools.ts";

const questions = [{
  name: "relevant",
  type: "predicate" as const,
  instructions: "Does this evidence relate to the task?",
}, {
  name: "category",
  type: "choice" as const,
  instructions: "Choose a typed value.",
  choices: [{ value: true }, { value: "true" }],
}, {
  name: "risk",
  type: "score" as const,
  instructions: "Score the impact.",
  levels: [{ label: "Cosmetic" }, { label: "Workaround" }, {
    label: "Blocked",
  }],
}];
const answers = [{
  name: "relevant",
  type: "predicate" as const,
  probability: 0.73,
}, {
  name: "category",
  type: "choice" as const,
  choice: true,
  confidence: 0.64,
  probabilities: [{ value: true, probability: 0.82 }, {
    value: "true",
    probability: 0.18,
  }],
}, {
  name: "risk",
  type: "score" as const,
  score: 1.6,
  confidence: 0.42,
  probabilities: [
    { label: "Cosmetic", value: 0, probability: 0.1 },
    { label: "Workaround", value: 1, probability: 0.2 },
    { label: "Blocked", value: 2, probability: 0.7 },
  ],
}];

function setup(repositoryRoot?: string, concurrency = 2, signal?: AbortSignal) {
  const globalArgs = model.globalArguments.parse({
    apiKey: "test-key",
    repositoryRoot,
    concurrency,
  });
  const harness = createModelTestContext({ globalArgs, signal });
  return { ...harness, context: { ...harness.context, globalArgs } };
}

function response(
  customAnswers: unknown = answers,
  inputTokens = 17,
): Response {
  return Response.json({
    model: "gpt-6-luna",
    answers: customAnswers,
    usage: {
      input_tokens: inputTokens,
      output_tokens: 0,
      total_tokens: inputTokens,
    },
    debug: "PROVIDER_RAW_EVIDENCE_MUST_NOT_PERSIST",
  });
}

async function withFetch(
  mock: typeof fetch,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function withRepo(run: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    await run(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function result(harness: ReturnType<typeof setup>) {
  const writes = harness.getWrittenResources();
  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "result");
  return model.resources.result.schema.parse(writes[0].data);
}

Deno.test("method schemas strip Swamp's merged global arguments and retain strict questions", () => {
  const globals = {
    apiKey: "GLOBAL_KEY_MUST_NOT_BECOME_EVIDENCE",
    repositoryRoot: "/tmp/example-repository",
    concurrency: 3,
  };
  assertEquals(
    model.methods.ask.arguments.parse({
      ...globals,
      input: "evidence",
      questions,
    }),
    { input: "evidence", questions },
  );
  assertEquals(
    model.methods.askFiles.arguments.parse({
      ...globals,
      questions,
      paths: ["source.ts"],
    }),
    {
      input: "",
      questions,
      paths: ["source.ts"],
      globs: [],
      mode: "per-file",
    },
  );
  assertEquals(
    model.methods.ask.arguments.safeParse({
      ...globals,
      input: "evidence",
      questions: [{ ...questions[0], unexpected: "rejected" }],
    }).success,
    false,
  );
});

Deno.test("ask batches native questions, correlates names, and strips raw provider state", async () => {
  const harness = setup();
  let calls = 0;
  await withFetch((url, init) => {
    calls++;
    assertEquals(String(url), "https://api.openai.com/v1/decisions");
    assertEquals(init?.method, "POST");
    assertEquals(init?.redirect, "error");
    assertEquals(
      new Headers(init?.headers).get("authorization"),
      "Bearer test-key",
    );
    assertEquals(
      new Headers(init?.headers).get("content-type"),
      "application/json",
    );
    assertEquals(JSON.parse(String(init?.body)), {
      model: "gpt-6-luna",
      input: "CALLER_SOURCE_SENTINEL",
      questions,
    });
    return Promise.resolve(response([answers[2], answers[0], answers[1]]));
  }, async () => {
    await model.methods.ask.execute({
      input: "CALLER_SOURCE_SENTINEL",
      questions,
    }, harness.context);
  });
  const output = result(harness);
  assertEquals(calls, 1);
  assertEquals(output.evaluations[0].answers, answers);
  assertEquals(output.usage, {
    input_tokens: 17,
    output_tokens: 0,
    total_tokens: 17,
  });
  assertEquals(output.requestCount, 1);
  assertEquals(output.refusalCount, 0);
  assertEquals(output.files, []);
  const persisted = JSON.stringify(harness.getWrittenResources());
  const logged = JSON.stringify(harness.getLogs());
  for (
    const sentinel of [
      "CALLER_SOURCE_SENTINEL",
      "PROVIDER_RAW_EVIDENCE_MUST_NOT_PERSIST",
      "test-key",
    ]
  ) {
    assert(!persisted.includes(sentinel));
    assert(!logged.includes(sentinel));
  }
});

Deno.test("mixed refusals remain explicit instead of becoming negative answers", async () => {
  const harness = setup();
  await withFetch(() =>
    Promise.resolve(response([
      answers[0],
      answers[1],
      { name: "risk", type: "refusal", reason: "RAW_REFUSAL_SENTINEL" },
    ])), async () => {
    await model.methods.ask.execute(
      { input: "evidence", questions },
      harness.context,
    );
  });
  const output = result(harness);
  assertEquals(output.refusalCount, 1);
  assertEquals(output.evaluations[0].answers[2], {
    name: "risk",
    type: "refusal",
  });
  assertEquals(output.evaluations[0].answers[0], answers[0]);
  assert(!JSON.stringify(output).includes("RAW_REFUSAL_SENTINEL"));
});

Deno.test("invalid names, choices, limits, and UTF-8 budgets fail before any HTTP or write", async () => {
  let calls = 0;
  const harness = setup();
  const invalid = [
    { input: "x", questions: [questions[0], questions[0]] },
    {
      input: "x",
      questions: [{
        ...questions[1],
        choices: [{ value: true }, { value: true }],
      }],
    },
    {
      input: "x",
      questions: [{
        ...questions[2],
        levels: [{ label: "same" }, { label: "same" }],
      }],
    },
    { input: "x", questions: [{ ...questions[0], type: "noul" }] },
    { input: "界".repeat(90_000), questions },
    {
      input: "x",
      questions: Array.from(
        { length: 33 },
        (_, i) => ({ ...questions[0], name: `q${i}` }),
      ),
    },
  ];
  await withFetch(() => {
    calls++;
    return Promise.resolve(response());
  }, async () => {
    for (const args of invalid) {
      await assertRejects(() =>
        model.methods.ask.execute(
          args as Parameters<typeof model.methods.ask.execute>[0],
          harness.context,
        )
      );
    }
  });
  assertEquals(calls, 0);
  assertEquals(harness.getWrittenResources(), []);
});

Deno.test("missing, duplicate, wrong-type, and incoherent API answers never produce results", async () => {
  const invalid = [
    answers.slice(1),
    [answers[0], answers[0], answers[2]],
    [{ ...answers[0], name: "unknown" }, answers[1], answers[2]],
    [
      {
        name: "relevant",
        type: "choice",
        choice: true,
        confidence: 0.9,
        probabilities: [{ value: true, probability: 1 }],
      },
      answers[1],
      answers[2],
    ],
    [{ ...answers[0], probability: 1.01 }, answers[1], answers[2]],
    [answers[0], { ...answers[1], choice: "unknown" }, answers[2]],
    [answers[0], {
      ...answers[1],
      probabilities: [{ value: true, probability: 0.82 }, {
        value: true,
        probability: 0.18,
      }],
    }, answers[2]],
    [answers[0], {
      ...answers[1],
      probabilities: [{ value: true, probability: 0.82 }, {
        value: "true",
        probability: 0.08,
      }],
    }, answers[2]],
    [answers[0], answers[1], { ...answers[2], score: 2.1 }],
    [answers[0], answers[1], { ...answers[2], score: 1.2 }],
    [answers[0], answers[1], {
      ...answers[2],
      probabilities: [{ label: "Cosmetic", value: 0, probability: 0.1 }, {
        label: "Blocked",
        value: 0,
        probability: 0.2,
      }, { label: "Workaround", value: 2, probability: 0.7 }],
    }],
  ];
  for (const custom of invalid) {
    const harness = setup();
    await withFetch(() => Promise.resolve(response(custom)), async () => {
      await assertRejects(() =>
        model.methods.ask.execute(
          { input: "evidence", questions },
          harness.context,
        )
      );
    });
    assertEquals(harness.getWrittenResources(), []);
  }
});

Deno.test("HTTP failures are sanitized, expose Retry-After, and do not retry or persist", async () => {
  for (const httpStatus of [401, 403, 429, 503]) {
    const harness = setup();
    let calls = 0;
    await withFetch(() => {
      calls++;
      return Promise.resolve(
        new Response("BODY_CONTAINS_SECRET", {
          status: httpStatus,
          headers: { "Retry-After": "11" },
        }),
      );
    }, async () => {
      const error = await assertRejects(
        () =>
          model.methods.ask.execute(
            { input: "evidence", questions },
            harness.context,
          ),
        Error,
        `HTTP ${httpStatus}`,
      );
      assert(!error.message.includes("BODY_CONTAINS_SECRET"));
      if (httpStatus === 429) {
        assert(error.message.includes("retry after 11 seconds"));
      }
    });
    assertEquals(calls, 1);
    assertEquals(harness.getWrittenResources(), []);
  }
  const harness = setup();
  await withFetch(() =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("HTTP_STREAM_SECRET"));
          },
        }),
        { status: 401 },
      ),
    ), async () => {
    const error = await assertRejects(
      () =>
        model.methods.ask.execute(
          { input: "evidence", questions },
          harness.context,
        ),
      Error,
      "HTTP 401",
    );
    assert(!error.message.includes("HTTP_STREAM_SECRET"));
  });
  assertEquals(harness.getWrittenResources(), []);
});

Deno.test("invalid JSON and errored streams preserve sanitized errors", async () => {
  for (
    const makeResponse of [
      () => new Response("INVALID_JSON_SECRET"),
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("STREAM_SECRET"));
            },
          }),
        ),
      () => new Response("x".repeat(1024 * 1024 + 1)),
    ]
  ) {
    const harness = setup();
    await withFetch(() => Promise.resolve(makeResponse()), async () => {
      const error = await assertRejects(
        () =>
          model.methods.ask.execute(
            { input: "evidence", questions },
            harness.context,
          ),
        Error,
        "invalid, interrupted, or oversized JSON",
      );
      assert(!error.message.includes("SECRET"));
    });
    assertEquals(harness.getWrittenResources(), []);
  }
});

Deno.test("per-file calls overlap within the bound and preserve file association on out-of-order completion", async () => {
  await withRepo(async (root) => {
    for (let i = 0; i < 5; i++) {
      await Deno.writeTextFile(
        `${root}/file-${i}.txt`,
        `FILE_PRIVATE_SENTINEL_${i}`,
      );
    }
    const harness = setup(root, 2);
    let active = 0;
    let peak = 0;
    let calls = 0;
    const completed: number[] = [];
    await withFetch(async (_url, init) => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      const payload = JSON.parse(JSON.parse(String(init?.body)).input);
      assertEquals(payload.input, "scout");
      const index = Number(payload.file.path.match(/file-(\d)/)[1]);
      assertEquals(payload.file.text, `FILE_PRIVATE_SENTINEL_${index}`);
      await new Promise((resolve) => setTimeout(resolve, index === 0 ? 25 : 2));
      active--;
      completed.push(index);
      return response(
        [{ ...answers[0], probability: (index + 1) / 10 }],
        index + 11,
      );
    }, async () => {
      await model.methods.askFiles.execute({
        input: "scout",
        questions: [questions[0]],
        globs: ["*.txt"],
      }, harness.context);
    });
    const output = result(harness);
    assertEquals(calls, 5);
    assertEquals(peak, 2);
    assertEquals(active, 0);
    assertEquals(completed[0], 1);
    assertEquals(output.evaluations.map((item) => item.path), [
      "file-0.txt",
      "file-1.txt",
      "file-2.txt",
      "file-3.txt",
      "file-4.txt",
    ]);
    assertEquals(
      output.evaluations.map((item) => item.answers[0]),
      [0.1, 0.2, 0.3, 0.4, 0.5].map((probability) => ({
        name: "relevant",
        type: "predicate" as const,
        probability,
      })),
    );
    assertEquals(output.usage.input_tokens, 65);
    assertEquals(output.requestCount, 5);
    assert(!JSON.stringify(output).includes("FILE_PRIVATE_SENTINEL"));
    assert(
      !JSON.stringify(harness.getLogs()).includes("FILE_PRIVATE_SENTINEL"),
    );
  });
});

Deno.test("combined mode deduplicates selectors and sends exactly one shared input", async () => {
  await withRepo(async (root) => {
    await Deno.writeTextFile(`${root}/a.txt`, "abc");
    await Deno.writeTextFile(`${root}/b.txt`, "PRIVATE_FILE_SENTINEL");
    const harness = setup(root);
    let calls = 0;
    await withFetch((_url, init) => {
      calls++;
      assertEquals(JSON.parse(JSON.parse(String(init?.body)).input), {
        input: "compare",
        files: [{ path: "a.txt", text: "abc" }, {
          path: "b.txt",
          text: "PRIVATE_FILE_SENTINEL",
        }],
      });
      return Promise.resolve(response());
    }, async () => {
      await model.methods.askFiles.execute({
        input: "compare",
        questions,
        paths: ["b.txt", "a.txt", "a.txt"],
        globs: ["*.txt"],
        mode: "combined",
      }, harness.context);
    });
    const output = result(harness);
    assertEquals(calls, 1);
    assertEquals(output.evaluations[0].path, undefined);
    assertEquals(output.files[0], {
      path: "a.txt",
      bytes: 3,
      sha256:
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
    assert(!JSON.stringify(output).includes("PRIVATE_FILE_SENTINEL"));
  });
});

Deno.test("path, symlink, sensitive-name, binary, and UTF-8 exclusions never send rejected contents", async () => {
  await withRepo(async (root) => {
    await withRepo(async (outside) => {
      await Deno.writeTextFile(`${root}/safe.txt`, "safe");
      await Deno.writeTextFile(`${root}/.env`, "SECRET_FILE_SENTINEL");
      await Deno.writeTextFile(
        `${outside}/outside.txt`,
        "OUTSIDE_FILE_SENTINEL",
      );
      await Deno.symlink(`${outside}/outside.txt`, `${root}/escape.txt`);
      await Deno.symlink(`${root}/.env`, `${root}/hidden-link.txt`);
      await Deno.writeFile(`${root}/binary.txt`, new Uint8Array([0, 65]));
      await Deno.writeFile(`${root}/invalid.txt`, new Uint8Array([0xff]));
      const harness = setup(root);
      await withFetch((_url, init) => {
        const sent = String(init?.body);
        assert(!sent.includes("SECRET_FILE_SENTINEL"));
        assert(!sent.includes("OUTSIDE_FILE_SENTINEL"));
        return Promise.resolve(response());
      }, async () => {
        await model.methods.askFiles.execute({
          questions,
          paths: [
            "safe.txt",
            ".env",
            "escape.txt",
            "hidden-link.txt",
            "binary.txt",
            "invalid.txt",
            "../outside.txt",
            "/etc/passwd",
            "C:\\outside.txt",
          ],
        }, harness.context);
      });
      const output = result(harness);
      assertEquals(output.files.map(({ path }) => path), ["safe.txt"]);
      assertEquals(output.skipped.length, 8);
      assertEquals(output.truncated, false);
    });
  });
});

Deno.test("file count and byte caps report truncation and accept the exact byte boundary", async () => {
  await withRepo(async (root) => {
    await Deno.writeTextFile(`${root}/boundary.txt`, "x".repeat(64 * 1024));
    await Deno.writeTextFile(
      `${root}/oversized.txt`,
      "x".repeat(64 * 1024 + 1),
    );
    const harness = setup(root);
    await withFetch(() => Promise.resolve(response()), async () => {
      await model.methods.askFiles.execute({
        questions,
        paths: ["boundary.txt", "oversized.txt"],
      }, harness.context);
    });
    const output = result(harness);
    assertEquals(output.files[0].bytes, 64 * 1024);
    assertEquals(output.files.length, 1);
    assertEquals(output.truncated, true);
    assertEquals(output.skipped, [{
      path: "oversized.txt",
      reason: "file or total byte limit exceeded",
    }]);
  });
  await withRepo(async (root) => {
    for (const name of ["a", "b", "c", "d"]) {
      await Deno.writeTextFile(`${root}/${name}.txt`, "x".repeat(64 * 1024));
    }
    const harness = setup(root);
    await withFetch(() => Promise.resolve(response()), async () => {
      await model.methods.askFiles.execute(
        { questions, globs: ["*.txt"] },
        harness.context,
      );
    });
    const output = result(harness);
    assertEquals(output.files.map(({ path }) => path), [
      "a.txt",
      "b.txt",
      "c.txt",
    ]);
    assertEquals(
      output.files.reduce((sum, item) => sum + item.bytes, 0),
      192 * 1024,
    );
    assertEquals(output.truncated, true);
    assertEquals(output.skipped, [{
      path: "d.txt",
      reason: "file or total byte limit exceeded",
    }]);
  });
  await withRepo(async (root) => {
    for (let i = 0; i < 21; i++) {
      await Deno.writeTextFile(
        `${root}/item-${String(i).padStart(2, "0")}.txt`,
        "x",
      );
    }
    const harness = setup(root);
    await withFetch(() => Promise.resolve(response()), async () => {
      await model.methods.askFiles.execute(
        { questions, globs: ["*.txt"] },
        harness.context,
      );
    });
    const output = result(harness);
    assertEquals(output.files.length, 20);
    assertEquals(output.truncated, true);
    assertEquals(output.skipped, [{
      path: "item-20.txt",
      reason: "file count limit exceeded",
    }]);
  });
});

Deno.test("all file request budgets are checked before starting the first API call", async () => {
  await withRepo(async (root) => {
    await Deno.writeTextFile(`${root}/a.txt`, "safe");
    await Deno.writeTextFile(`${root}/z.txt`, "\\".repeat(64 * 1024));
    const harness = setup(root);
    let calls = 0;
    await withFetch(() => {
      calls++;
      return Promise.resolve(response());
    }, async () => {
      await assertRejects(
        () =>
          model.methods.askFiles.execute(
            { questions, globs: ["*.txt"] },
            harness.context,
          ),
        Error,
        "240-KiB budget",
      );
    });
    assertEquals(calls, 0);
    assertEquals(harness.getWrittenResources(), []);
  });
});

Deno.test("a failed batch cancels in-flight requests and queues no more work or partial writes", async () => {
  await withRepo(async (root) => {
    for (const path of ["a.txt", "b.txt", "c.txt"]) {
      await Deno.writeTextFile(`${root}/${path}`, path);
    }
    const harness = setup(root, 2);
    let calls = 0;
    let aborted = 0;
    await withFetch((_url, init) => {
      calls++;
      const payload = JSON.parse(JSON.parse(String(init?.body)).input);
      if (payload.file.path === "a.txt") {
        return Promise.resolve(
          new Response("private failure", { status: 503 }),
        );
      }
      return new Promise((_resolve, reject) => {
        const cancel = () => {
          aborted++;
          reject(new Error("RAW_ABORT_SECRET"));
        };
        if (init?.signal?.aborted) cancel();
        else init?.signal?.addEventListener("abort", cancel, { once: true });
      });
    }, async () => {
      const error = await assertRejects(
        () =>
          model.methods.askFiles.execute(
            { questions, globs: ["*.txt"] },
            harness.context,
          ),
        Error,
        "HTTP 503",
      );
      assert(!error.message.includes("SECRET"));
    });
    assertEquals(calls, 2);
    assertEquals(aborted, 1);
    assertEquals(harness.getWrittenResources(), []);
  });
});

Deno.test("already-cancelled requests make no HTTP calls or writes", async () => {
  const controller = new AbortController();
  controller.abort();
  const harness = setup(undefined, 2, controller.signal);
  let calls = 0;
  await withFetch(() => {
    calls++;
    return Promise.resolve(response());
  }, async () => {
    await assertRejects(() =>
      model.methods.ask.execute(
        { input: "evidence", questions },
        harness.context,
      )
    );
  });
  assertEquals(calls, 0);
  assertEquals(harness.getWrittenResources(), []);
});
