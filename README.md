# `danielroe/provenance-action`

Detect and fail CI when dependencies in your lockfile lose npm provenance or trusted publisher status.

> [!WARNING]
> This action is under active development and is only one tool to assist in securing your dependencies.

## ✨ Features
- `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock` (v1 and v2+)
- Handles transitives by comparing resolved versions
- Inline GitHub annotations at the lockfile line
- JSON output and optional hard‑fail (default: on)
- Pure TypeScript, Node 24+

👉 See it in action: [danielroe/provenance-action-test](https://github.com/danielroe/provenance-action-test)

## 🚀 Quick start
```yaml
name: ci
on:
  pull_request:
    branches:
      - main
permissions:
  contents: read
jobs:
  check-provenance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Check provenance downgrades
        uses: danielroe/provenance-action@latest
        id: check
        with:
          fail-on-provenance-change: true # optional, default: false
        #   lockfile: pnpm-lock.yaml      # optional
        #   base-ref: origin/main         # optional, default: origin/main
        #   fail-on-downgrade: true       # optional, default: true
      - name: Print result
        run: "echo 'Downgraded: ${{ steps.check.outputs.downgraded }}'"
```

## 🔧 Inputs
- `lockfile` (optional): Path to the lockfile. Auto-detected if omitted.
- `workspace-path` (optional): Path to workspace root. Default: `.`
- `base-ref` (optional): Git ref to compare against. Default: `origin/main`.
- `fail-on-downgrade` (optional): Controls failure behavior. Accepts `true`, `false`, `any`, or `only-provenance-loss`. Default: `true` (which is the same as `any`).
- `fail-on-provenance-change` (optional): When `true`, fail on provenance repository/branch changes. Default: `false`.

## 📤 Outputs
- `downgraded`: JSON array of `{ name, from, to, downgradeType }` for detected downgrades. `downgradeType` is `provenance` or `trusted_publisher`.
- `changed`: JSON array of provenance change events `{ name, from, to, type, previousRepository?, newRepository?, previousBranch?, newBranch? }`.

## 🧠 How it works
1. Diffs your lockfile against the base ref and collects changed resolved versions (including transitives).
2. Checks npm provenance via the attestations API for each `name@version`.
3. Falls back to version metadata for `dist.attestations`.
4. Emits file+line annotations in the lockfile.
5. If provenance exists for both the previous and new version, extracts GitHub `owner/repo` and branch from attestations and warns when they differ (repo changed or branch changed).

## 🔒 Why this matters
Trusted publishing links a package back to its source repo and build workflow, providing strong provenance guarantees. It helps ensure the package you install corresponds to audited source and CI.

However, maintainers can still be phished or coerced into publishing without trusted publishing enabled, or switching to a non‑trusted path. In those cases, packages may still carry attestations, but the chain back to the trusted publisher can be weakened.

This action:
- Detects when a dependency update loses npm provenance (no attestations) or loses trusted publisher (attestations but no trusted publisher marker), and
- Fails CI by default (configurable), before that change lands in your main branch.

This is a stopgap until package managers enforce stronger policies natively. Until then, it offers a lightweight guardrail in CI.

## ⚠️ Notes
- Runs on Node 24+ and executes the TypeScript entrypoint directly.
- Bun (`bun.lockb`) is not yet supported.
 - Repository and branch change detection is best‑effort; attestation shapes vary and some packages omit repo/ref details.
