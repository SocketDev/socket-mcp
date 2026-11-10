# Publish to npm

Run `pnpm run publish:npm` from the repository. The first run creates a signed release preparation commit and opens a pull request with the package version, extension manifest, README asset pins, and changelog update. Review and merge that PR through the normal required checks. Run `pnpm run publish:npm` again to reserve its version tag, build and validate the package, and stage it with npm provenance.

The workflow uses the highest stable version actually published on npm as its changelog baseline. It resolves that release from its version tag or ancestor `gitHead`; when npm has neither, it uses the first parent commit that changed `package.json` to the published version and verifies that commit is an ancestor. If no stable version is published it includes all history. Fix only changes bump the patch version. Other meaningful changes bump minor. A committed prerelease version is treated as a hint and its prerelease suffix is removed. Existing published versions and tags are skipped; a reserved version is never reused.

An explicit release config is required at `.config/release.json`, `release.json`, or `.release.json`. Missing, invalid, or conflicting configs stop release preparation. The current `stable-from-hint` mode keeps the normal stable release flow. A `prerelease-only` track declares a stable `versionHint`, a prerelease `identifier`, and its matching npm `distTag`; each preparation advances only the numeric prerelease suffix. Validation rejects stable versions and mismatched tags, and GitHub marks the resulting release as a prerelease. For example:

```json
{
  "mode": "prerelease-only",
  "versionHint": "2.1.0",
  "identifier": "rc",
  "distTag": "prerelease-2.1.0"
}
```

The resume run must target the exact default branch commit created by the preparation PR. If the branch advances before that run, the workflow creates a new preparation PR from the newer source commit.

The workflow packs the package once, validates the archive, and uploads the same bytes to npm staging with OIDC provenance. The Actions log and summary show package, version, tag, and stage ID. After reviewing the staged package in npm, approve it from a local checkout with:

```sh
pnpm run approve:npm <stage-id>
```

Approval waits for npm validation, approves the exact stage, then dispatches GitHub release finalization. Workflow reruns refuse another upload. If a stage upload succeeds but its ID is missing from the run output, recover it in npm before starting another release. Do not delete or reassign a reserved version tag; create a new release preparation instead.
