# Contributing

Thanks for improving WebPage Analyzer.

## Development workflow

1. Fork the repository and create a focused branch.
2. Copy the `.env.example` files; never commit real API keys or target data.
3. Install dependencies with `npm ci` in both `backend` and `frontend`.
4. Add tests for behavior changes. Backend tests must mock DNS, browsers, YellowLab, and Gemini unless an explicitly manual integration test is being added.
5. Run the complete verification commands from the README.
6. Open a pull request describing behavior, security impact, and manual verification.

## Security-sensitive changes

Changes to URL parsing, DNS policy, proxying, redirects, Chromium flags, auth, rate limiting, or Markdown rendering require regression tests. Preserve the default-deny rules for private/reserved destinations. Never weaken a control just to make one target scan successfully; propose a narrowly scoped, documented configuration instead.

## Style

- Keep modules small and dependency-inject external work so tests stay deterministic.
- Return stable API error codes and keep internal error details in server logs.
- Avoid storing raw analyzer output longer than necessary.
- Keep user-facing text clear and avoid unsupported performance or revenue claims.

By contributing, you agree that your contribution is licensed under the MIT License.
