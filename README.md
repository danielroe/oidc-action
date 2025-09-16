# `danielroe/provenance-action`

Detect dependencies that lost npm provenance (trusted publishing) from your lockfile.

> [!WARNING]  
> This action is under active development and is only one tool to assist in securing your dependencies.

## ✨ Features
- `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock` (v1)
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
jobs:
  check-provenance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Check provenance downgrades
        uses: danielroe/provenance-action
        id: check
        # with:
        #   lockfile: pnpm-lock.yaml # optional
        #   base-ref: origin/main    # optional, default: origin/main
        #   fail-on-downgrade: true  # optional, default: true
      - name: Print result
        run: echo "Downgraded: ${{ steps.check.outputs.downgraded }}"
```

## 🔧 Inputs
- `lockfile` (optional): Path to the lockfile. Auto-detected if omitted.
- `workspace-path` (optional): Path to workspace root. Default: `.`
- `base-ref` (optional): Git ref to compare against. Default: `origin/main`.
- `fail-on-downgrade` (optional): Controls failure behavior. Accepts `true`, `false`, `any`, or `only-provenance-loss`. Default: `true` (which is the same as `any`).

## 📤 Outputs
- `downgraded`: JSON array of `{ name, from, to, downgradeType }` for detected downgrades. `downgradeType` is `provenance` or `trusted_publisher`.

## 🧠 How it works
1. Diffs your lockfile against the base ref and collects changed resolved versions (including transitives).
2. Checks npm provenance via the attestations API for each `name@version`.
3. Falls back to version metadata for `dist.attestations`.
4. Emits file+line annotations in the lockfile.

## ⚠️ Notes
- Runs on Node 24+ and executes the TypeScript entrypoint directly.
- Yarn Berry (`yarn.lock` v2+) and Bun (`bun.lockb`) are not yet supported.
