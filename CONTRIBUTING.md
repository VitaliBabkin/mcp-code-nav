# Contributing

Thanks for helping. The short version:

1. Fork, branch, `npm ci`.
2. Make the change with tests. Bug fixes come with a regression test that fails before the fix.
3. Run the gates and make them pass; the list, and when to also run the live suite, is in
   [WORKFLOW.md](WORKFLOW.md).
4. Open a pull request describing what changed and why.

The details are in two documents:

- [WORKFLOW.md](WORKFLOW.md): setup, the pull request flow, the live test suite and the tools it needs, review, how to
  add a tool for a new language, commit messages.
- [PRINCIPLES.md](PRINCIPLES.md): the rules every change must keep (no silent empty results, input validation, narrow
  scope, process hygiene, test expectations).

AI coding assistants: see [AGENTS.md](AGENTS.md).

## Reporting problems

What to include in a problem report is in [WORKFLOW.md](WORKFLOW.md) under "Reporting problems".

## Security

Do not open a public issue for a vulnerability; follow [SECURITY.md](SECURITY.md). `npm audit --omit=dev` checks the
shipped dependency surface; the full `npm audit` also reports the dev toolchain, which is not published.
