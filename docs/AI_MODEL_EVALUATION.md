# OpenRouter model evaluation gate

This document records the deployment-time model-selection gate. It does not
make a permanent source-code model choice and it is not evidence that a live
provider request has succeeded.

## Catalog snapshot

The public [OpenRouter Models API](https://openrouter.ai/api/v1/models) was read
on 2026-08-15. The prices below are derived from the API's per-token USD fields;
they are a point-in-time shortlist, not a contractual price promise.

| Candidate | Prompt / 1M | Completion / 1M | Context | Structured output | Expiration | Reason to evaluate |
| --- | ---: | ---: | ---: | --- | --- | --- |
| `mistralai/mistral-small-24b-instruct-2501` | $0.05 | $0.08 | 32,768 | yes | none published | Low cost and sufficient context; remediation quality still needs measurement. |
| `upstage/solar-pro4` | $0.03 | $0.12 | 524,288 | yes | none published | Very low catalog price and ample context; recent availability and quality need measurement. |
| `deepseek/deepseek-v4-flash-0731` | $0.14 | $0.28 | 1,048,576 | yes | none published | Higher catalog coding signal at still-low cost; latency/privacy routing need measurement. |

The shortlist excludes `openrouter/free` as the sole production dependency,
batch-only IDs, currently published expiration dates, and models without text
input/output or `structured_outputs`. Official metadata does not prove the
latency, rate limit, provider privacy route, or WPA-specific answer quality of
any candidate.

## Reproducible harness

The repository contains 24 synthetic, anonymized findings across accessibility,
performance, security hygiene, SEO, browser errors, headers, caching, UX and
source-code issues. The harness measures schema success, actionable content,
technical terminology, guarantee/hallucination signals, latency, tokens and
provider-reported cost. Every record remains `humanReview: not_reviewed` until
an operator actually reviews it.

Safe deterministic check; this performs no provider request:

```sh
cd backend
npm run ai:evaluate > ../artifacts/ai-evaluation-synthetic.json
```

Live candidate check; this is intentionally disabled unless both a key and an
explicit cost opt-in are supplied:

```sh
cd backend
AI_EVAL_ALLOW_PROVIDER_CALLS=true \
OPENROUTER_API_KEY='REDACTED' \
OPENROUTER_MODEL_PRIMARY='provider/model' \
OPENROUTER_MODEL_FALLBACKS='' \
OPENROUTER_SITE_URL='https://app.example.com' \
OPENROUTER_APP_NAME='WebPageAnalyzer' \
npm run ai:evaluate -- --live > ../artifacts/ai-evaluation-provider-model.json
```

Never commit the API key or raw customer prompts. Run each candidate with the
same fixtures, prompt and schema. Select the lowest-cost candidate that passes
the agreed schema, technical-correctness and human-review threshold; then place
only its model ID in `OPENROUTER_MODEL_PRIMARY` and ordered compatible fallbacks
in `OPENROUTER_MODEL_FALLBACKS`.

## Current decision

No live inference was authorized or possible in this workstation run, so no
candidate is declared production-approved. Production configuration therefore
fails closed when `OPENROUTER_MODEL_PRIMARY` is missing. Model selection remains
a launch blocker, not a hidden hard-coded default.

Official behavior references:

- [Models and metadata](https://openrouter.ai/docs/guides/overview/models)
- [Structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
- [Model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks)
- [Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
- [Provider data collection controls](https://openrouter.ai/docs/guides/privacy/data-collection)
