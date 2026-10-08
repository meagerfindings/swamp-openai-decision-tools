# @mgreten/openai-decision-tools

A standalone Swamp model extension for getting small, typed, **advisory**
judgments about supplied text or selected repository files. It calls OpenAI's
Decisions API with `gpt-6-luna`; it does not execute commands, edit files, or
authorize actions.

This is an independent OpenAI-backed implementation of the agent-facing
cheap-read pattern credited to IndyDevDan in
[“10 Levels of Jev For Agentic Engineers”](https://www.youtube.com/watch?v=_U-O5lYhJ7Q).
It is not a Jev extension, has no Jev dependency, and bundles no workflows.

## What it does

The model exposes two operations:

- **`ask`** evaluates a caller-supplied input string against multiple named
  questions in one API request.
- **`askFiles`** evaluates repository files selected by relative paths or globs,
  with an optional supplemental input string. In `combined` mode the selected
  files are evaluated together; in `per-file` mode each file gets a separate API
  request. Per-file requests use bounded internal concurrency.

Question types follow the Decisions API:

| Type        | Question definition                                           | Result meaning                                                                         |
| ----------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `predicate` | `instructions`                                                | Estimated probability, from 0 to 1, that a condition is true.                          |
| `choice`    | `instructions` and `choices: [{ value, description }]`        | A selected supplied value, with option probabilities/confidence from the API.          |
| `score`     | `instructions` and ordered `levels: [{ label, description }]` | A probability-weighted score across ordered levels; it can fall between level indices. |

Every question needs a unique `name`. Several questions can share the same input
in one request. Use a predicate for a yes/no-like condition, a choice for
distinct unordered categories, and a score for ordered rubric levels. A refusal
is represented explicitly as a refusal answer; it is not treated as a negative
predicate.

## Configuration and limits

- The API key is an optional sensitive `apiKey` argument. If omitted, the model
  uses `OPENAI_API_KEY`.
- `repositoryRoot` is an optional absolute path and is required for `askFiles`.
- `concurrency` is an integer from 1 through 8 and defaults to 4. It bounds
  simultaneous per-file requests; it does not combine those requests.
- The model is fixed to `gpt-6-luna` and sends requests to
  `POST https://api.openai.com/v1/decisions`.
- A call accepts 1–32 uniquely named questions. Choice requires 2–255 distinct
  typed values; score requires 2–10 distinct ordered labels.
- File selection is capped at 20 files, 64 KiB per file, and 192 KiB total.
  Globs support `*`, `**`, and `?`; traversal is capped at 10,000 entries and 12
  directory levels. Hidden and sensitive-looking paths, binary/invalid UTF-8,
  and resolved paths outside the root are omitted. These controls are not a
  security sandbox or a secret scanner.
- Requests must fit within 240 KiB after JSON encoding; responses are capped at
  1 MiB. Each HTTP request has a 30-second deadline and honors invocation
  cancellation. HTTP failures do not retry automatically; a 429 error includes a
  valid `Retry-After` delay when supplied.
- If any requested evaluation fails, the run rejects rather than returning a
  final partial result. Successful results do not persist raw evidence, but this
  does not erase text elsewhere in the workflow or CLI history.

Treat the supplied text, file contents, paths, and option labels as potentially
sensitive. In particular, `askFiles` sends selected source content to OpenAI.
The provider/account's retention and data controls are separate from whether
this model persists evidence in its result. Review OpenAI's
[data controls](https://developers.openai.com/api/docs/guides/your-data) and
your organization's policy before sending sensitive material.

## Configure a repository-specific instance

After publication, install with
`swamp extension pull @mgreten/openai-decision-tools`. During local development,
run Swamp from this source repository, or register it in an existing Swamp repo
with `swamp extension source add /path/to/swamp-openai-decision-tools`.

Create a vault and store the API key with the hidden interactive prompt; do not
put a real key in the command line or a committed model definition:

```bash
swamp vault create local_encryption openai --json
swamp vault put openai api-key
swamp model create @mgreten/openai-decision-tools repo-scout \
  --global-arg 'apiKey=${{ vault.get("openai", "api-key") }}' \
  --global-arg "repositoryRoot=$HOME/git/matgreten.dev" \
  --global-arg concurrency=4 --json
```

These are global arguments, not `ask` or `askFiles` inputs. Use the approved
OpenAI account/project configuration for your organization; installing this
package does not establish approval or Zero Data Retention eligibility.

## Examples

Pass the JSON objects below through the corresponding method using stdin:

```bash
swamp model method run repo-scout askFiles --stdin --json < files-query.json
swamp model method run repo-scout ask --stdin --json < failure-query.json
```

Example post paths are relative to the configured `repositoryRoot`. These are
public `matgreten.dev` posts, not CompanyCam source. All three modes below were
verified against OpenAI on October 8, 2026; see the measured results below.

### Scout two posts, then inspect likely matches

Include a negative control to check the relevance boundary, and score likely fit
separately from the relevance predicate. `per-file` mode lets the questions
classify each post independently.

```json
{
  "input": "Find articles whose main subject is verifying software behavior with tests or assertions.",
  "paths": [
    "posts/trust-but-assert/index.html",
    "posts/saving-money-cell-phone/index.html"
  ],
  "mode": "per-file",
  "questions": [
    {
      "type": "predicate",
      "name": "relevant_to_assertion_trust",
      "instructions": "Is the main article in file.text primarily about verifying software behavior through tests or assertions? Ignore navigation, links, the filename, and passing references."
    },
    {
      "type": "choice",
      "name": "primary_topic",
      "instructions": "Classify the main article in file.text by its substantive content. Ignore navigation, links, and the filename.",
      "choices": [
        {
          "value": "trust_and_verification",
          "description": "Testing or asserting software behavior."
        },
        {
          "value": "phone_cost_savings",
          "description": "Reducing the cost of a mobile phone or phone plan."
        },
        {
          "value": "other",
          "description": "Neither subject is a substantial match."
        }
      ]
    },
    {
      "type": "score",
      "name": "topic_fit",
      "instructions": "Rate the main article in file.text for its focus on testing or asserting software behavior. Ignore navigation, links, and the filename.",
      "levels": [
        {
          "label": "No fit",
          "description": "Unrelated; the target topic is absent or only a misleading superficial match."
        },
        {
          "label": "Tangential",
          "description": "A brief or secondary connection, not a main topic."
        },
        {
          "label": "Strong fit",
          "description": "Testing or asserting software behavior is the main subject."
        }
      ]
    }
  ]
}
```

The testing article is the positive control and the phone-cost article is the
negative control; those expectations belong in the evaluation, not the questions
sent to the model. Use the result as a scouting signal and validate thresholds
against labeled examples. Per-file input is JSON text with
`{input, file: {path,
text}}`. Combined input has
`{input, files: [{path, text}, ...]}` instead; change questions to refer to
`files` when comparing articles together. Every question in a request sees the
same evidence; dependent decisions require separate calls.

### Triage supplied test failure evidence

For failure triage, provide the test output and any relevant diff or source
excerpt as the `ask` input. Keep questions grounded in the supplied evidence;
the model does not run tests or independently inspect omitted files.

```json
{
  "input": "TEST OUTPUT:\nFAIL src/parser.test.ts > parses quoted values\nExpected: \"a b\"\nReceived: \"a\"\n\nRELEVANT CHANGE:\nThe tokenizer now ends a token at whitespace without checking whether it is inside quoted text.\n",
  "questions": [
    {
      "type": "predicate",
      "name": "failure_explained_by_change",
      "instructions": "Does the supplied change plausibly explain the reported test failure, based only on the included evidence?"
    },
    {
      "type": "choice",
      "name": "triage_category",
      "instructions": "Choose the best next triage category for this failure.",
      "choices": [
        {
          "value": "likely_regression",
          "description": "The included change plausibly caused the failing behavior."
        },
        {
          "value": "needs_more_context",
          "description": "The evidence is insufficient to connect the failure to a cause."
        },
        {
          "value": "likely_test_or_environment",
          "description": "The evidence points more strongly to a test expectation or environment issue."
        }
      ]
    },
    {
      "type": "score",
      "name": "impact",
      "instructions": "Rate the apparent user impact if this failure reflects a real regression.",
      "levels": [
        {
          "label": "Low",
          "description": "Narrow edge case with a straightforward workaround."
        },
        {
          "label": "Moderate",
          "description": "A meaningful behavior is impaired, but a workaround or limited scope is evident."
        },
        {
          "label": "High",
          "description": "A core task is broadly blocked or data integrity may be affected."
        }
      ]
    }
  ]
}
```

This result is a triage hint only. A human or a separate deterministic process
should inspect the source, reproduce the failure, and decide what to change.

### Compare the files in one request

Use `combined` mode when a question needs to compare the selected files. Every
question sees the same `files` array. This example selects a path from supplied
options rather than generating a filename or tool arguments.

```json
{
  "input": "Compare the selected articles for their focus on verifying software behavior with runtime assertions.",
  "paths": [
    "posts/trust-but-assert/index.html",
    "posts/saving-money-cell-phone/index.html"
  ],
  "mode": "combined",
  "questions": [
    {
      "type": "predicate",
      "name": "contains_assertion_article",
      "instructions": "Does at least one main article in files[].text primarily explain verifying software behavior with runtime assertions? Ignore filenames, metadata, navigation, and passing references."
    },
    {
      "type": "choice",
      "name": "assertion_article",
      "instructions": "Select the file.path whose main article in files[].text best explains verifying software behavior with runtime assertions. Judge substantive article content, not filenames or metadata. Choose neither if none fits.",
      "choices": [
        {
          "value": "posts/trust-but-assert/index.html",
          "description": "The article supplied at this path."
        },
        {
          "value": "posts/saving-money-cell-phone/index.html",
          "description": "The article supplied at this path."
        },
        {
          "value": "neither",
          "description": "No supplied article primarily covers runtime assertion verification."
        }
      ]
    },
    {
      "type": "score",
      "name": "strongest_topic_fit",
      "instructions": "Rate the strongest main-article match in files[].text for its focus on verifying software behavior with runtime assertions. Ignore filenames, metadata, navigation, and passing references.",
      "levels": [
        {
          "label": "No fit",
          "description": "The subject is absent from the main articles."
        },
        {
          "label": "Tangential",
          "description": "The subject is a minor connection, not a main topic."
        },
        {
          "label": "Strong fit",
          "description": "At least one article primarily explains this subject."
        }
      ]
    }
  ]
}
```

## Persisted result

Both methods write one `result` resource with a seven-day lifetime and a
100-version garbage-collection setting. Its fields are:

- `mode`, `requestCount`, `refusalCount`, `evaluatedAt`.
- `evaluations`: one entry for `ask` or combined mode, one per selected file in
  per-file mode. Each entry contains `answers`, the returned `model`, `usage`,
  and `durationMs`; per-file entries also contain `path`.
- `files`: selected paths with `bytes` and `sha256`, without their text.
- `skipped` and `truncated`: omissions are not negative judgments. When no
  readable text file remains, `askFiles` fails rather than judging missing text.
- `usage`: summed `input_tokens`, `output_tokens`, and `total_tokens` from the
  provider. This is not a price estimate.
- `durationMs`: method processing time through validated answers, including file
  selection and HTTP calls, but excluding final persistence and CLI startup.

Answers retain native `name` and `type` fields. Predicates include
`probability`; choices include `choice`, `confidence`, and typed
`probabilities`; scores include `score`, `confidence`, and indexed
`probabilities`. Refusals include only `name` and `type: "refusal"`. The model
checks exact answer correlation and rejects malformed responses; provider debug
fields and raw refusal messages are discarded. Raw evidence and question
instructions are not written into this resource or the model's diagnostic logs.
Caller-supplied method inputs may still appear in Swamp run history, reports,
workflow definitions, or audit records. Paths and answer labels can also carry
sensitive information. Review all retention layers.

## A practical agent workflow

Use this as **semantic scouting**, not a replacement for search or source
review:

1. Use `askFiles` to identify candidate files or prioritize a batch by meaning,
   with positive and negative controls when the boundary is ambiguous.
2. Use exact search (for example, `rg`) for known symbols, literal strings, call
   sites, or every occurrence of a pattern. Exact search answers “where is this
   text/symbol?”; a semantic judgment answers “does this content appear to fit
   this intent?” Neither substitutes for the other.
3. Read the relevant source and nearby tests before editing. Confirm the model's
   judgment against actual code and repository context; then make the smallest
   justified change and run the relevant checks.
4. Treat scores, probabilities, and classifications as advisory signals, never
   as authorizations to edit, execute, deploy, approve, or skip validation.

## Measured results

Live smoke tests used the exact examples above, `gpt-6-luna`, a vault-backed
key, and `concurrency: 4` on macOS ARM64 on October 8, 2026. Each request
exercised predicate, choice, and score answers. No CompanyCam source was sent.

| Example                                    | HTTP requests | Processing time | Input tokens | Observed answer                                                                                                   |
| ------------------------------------------ | ------------: | --------------: | -----------: | ----------------------------------------------------------------------------------------------------------------- |
| `ask`: supplied parser failure             |             1 |          369 ms |          517 | `likely_regression`; explanation probability 1; impact 0.96/2.                                                    |
| `askFiles`, per-file: two articles         |             2 |          682 ms |        8,518 | Assertion article relevant at 0.98, fit 2/2; phone article relevant at 0, fit 0/2; both topic categories correct. |
| `askFiles`, combined: compare two articles |             1 |          399 ms |        8,027 | Selected `posts/trust-but-assert/index.html`; contains-assertion-article probability 1; fit 2/2.                  |

The file inputs totaled 29,905 bytes. Per-file request durations were 389 ms and
679 ms; the batch finished in 682 ms, confirming overlapping requests within one
invocation. Questions are batched per shared input. Independent files still need
separate requests in per-file mode; combined mode avoids duplicating shared
question overhead but cannot substitute for one evaluation per file.

Times are rounded from the persisted `durationMs`: file selection and HTTP
evaluation through validated answers, excluding final persistence and CLI
startup. These are **single-run smoke measurements**, not percentiles, a latency
guarantee, a general accuracy benchmark, or a comparison with Jev. Probabilities
and confidence remain model estimates. The 14-test mocked suite also passes; it
covers failure paths, refusals, privacy, limits, correlation, and concurrency
that these successful live examples do not exercise.

## OpenAI API references

- [Decisions guide](https://developers.openai.com/api/docs/guides/decisions)
- [Create a decision API reference](https://developers.openai.com/api/reference/resources/decisions/methods/create)

## License

MIT. See [LICENSE.txt](LICENSE.txt).
