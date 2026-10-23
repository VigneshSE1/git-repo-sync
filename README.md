# Git Repo Sync

A local web app that keeps two repositories holding the same codebase in step:

- **Organization repo** — source of truth. Its `develop` is authoritative.
- **Intern repo** — where interns work.

Two guided workflows:

1. **Sync Org → Intern** – bring the latest org `develop` into the intern repo before development.
2. **Transfer Intern PR → Org** – move a *reviewed* intern PR into the org repo as a **new branch + PR**. A human merges it; the tool never does.

All Git runs **on the server** (Next.js route handlers → `simple-git`). The browser only calls a JSON API; tokens never leave the server.

## Setup

Requirements: Node 20+, Git 2.38+ (needs `git merge-tree --write-tree`), and working Git credentials (credential manager or SSH) for your remotes.

```bash
npm install
cp .env.example .env.local     # optional: only needed for PR listing / PR creation
npm run dev                    # http://localhost:3000
```

Open the app. The **Setup wizard** asks for repo URLs, local clone paths, branches (default `develop`), provider, workflow preferences, tests Git access, validates the clones, and shows a review screen before enabling writes. No repos yet? Click **Use demo repositories** to get throw-away local repos (org ahead of intern, two intern PR branches, one of which conflicts) and try every flow safely.

### Environment variables (`.env.local`, server-side only)

| Variable | Purpose |
| --- | --- |
| `GITHUB_TOKEN_INTERN` | Read intern PRs / commits / files |
| `GITHUB_TOKEN_ORG` | Create the org PR |
| `GITHUB_TOKEN` | Fallback for either role |
| `GITHUB_API_URL` | GitHub Enterprise Server API base (default `https://api.github.com`) |
| `GIT_REPO_SYNC_DATA_DIR` | Where config, state and logs live (default `./.git-repo-sync`, git-ignored) |

Never paste tokens into the UI or chat; the app has no field for them. Config files contain URLs, paths and preferences only; URLs with embedded credentials are rejected.

### GitHub token permissions

Use fine-grained personal access tokens scoped to the single repository each role needs:

- **Intern token:** *Pull requests: Read*, *Contents: Read* (and *Metadata: Read*, implicit).
- **Org token:** *Pull requests: Read & write*. (The branch itself is pushed with your normal Git credentials, not the token.)
- For SSO-protected orgs, authorize the token for the org.

Without a token everything Git-based still works (validation, sync, cherry-pick, pushing the branch); PR listing/creation is reported as unavailable, never faked. Azure DevOps / "other" providers are git-only for now; add a provider by implementing `GitProvider` in [src/server/providers/types.ts](src/server/providers/types.ts) and registering it in `providers/index.ts`.

## Using it

### Sync Org → Intern
1. **Fetch & compare** – fetches both remotes, shows each `develop` tip, ahead/behind, commits on each side, changed files, predicted conflicts (in-memory `merge-tree`, nothing touched) and a diff preview.
2. Pick a strategy:
   - **Safe merge** (default): merges org into intern, keeps intern-only commits; never needs force.
   - **Exact sync**: makes intern identical to org. Lists the commits it would discard, requires typing `DISCARD`.
3. **Apply locally** – creates a recovery branch `backup/<branch>-<timestamp>-<sha>` first, then merges/resets locally. Conflicts abort the merge and leave the branch untouched.
4. **Verify & push** – checks ancestry/tree equality and a clean tree, then pushes only after a confirmation dialog. If history must be rewritten the push uses `--force-with-lease=<fetched sha>` and needs typing `FORCE PUSH`. The remote is re-fetched right before pushing and the push is refused if it moved.

### Transfer Intern PR → Org
1. Select an open/merged intern PR (or enter a PR URL/number when manual discovery is chosen).
2. **Review commits** – fetches the PR *head ref* (not stored SHAs) and classifies each commit: `ready`, `merge`, `already-in-org`, `equivalent-in-org` (same patch, different SHA), `already-transferred`, `not-in-head` (rebased/force-pushed), `missing`. Only `ready` commits can be cherry-picked; otherwise use the **patch-based** strategy (one reviewed commit from the PR's full diff).
3. **Transfer** – creates `sync/intern-pr-<N>` from freshly fetched `org/develop`, cherry-picks in PR order with `-x`, and stops on any conflict. A change that is already present is recorded as `skipped-empty`, never silently dropped.
4. **Review** the final commit list, stat and diff.
5. **Publish** – after confirmation, pushes the branch (never `develop`, never forced) and opens a PR into `develop` containing the original PR link, commit list and diff summary. Existing org PRs are reused; repeated publishes are refused.

Preview-only mode (default) disables every write until you turn it off in Setup → Review. Each remote write still needs its own confirmation.

## Recovery

| Situation | What to do |
| --- | --- |
| Sync applied locally, not pushed | **Roll back local result** in the Sync screen, or `git switch develop && git reset --hard backup/develop-…` in the intern clone |
| Exact sync pushed by mistake | Intern remote history was rewritten; recover from the local `backup/develop-…` branch (`git push --force-with-lease origin backup/develop-…:develop`) |
| Merge conflicts in Sync | Nothing changed (merge auto-aborted). Merge org develop manually in the intern clone, commit, re-run the preview |
| Transfer stopped on a conflict | Resolve the files, `git add` them, press **Continue**; or **Abort** (restores your original branch, deletes the transfer branch) |
| Branch pushed but PR creation failed | Press Publish again (push is skipped when already done), or open the PR with the shown compare link |
| Stale state | `.git-repo-sync/state.json` holds sync/transfer records; the operation log is `.git-repo-sync/operations.log` (secrets redacted) |

## Safety design

- argv-only Git execution through `simple-git`; no shell strings, no user-supplied commands. URLs are allow-listed (`https`, `ssh`, `git@host:path`, local path; `ext::`/option-looking values rejected); branches and SHAs are validated with Zod.
- Repo identity check (clone root, remote URL matches config, branch exists) before every operation; one operation per repository at a time.
- Uncommitted tracked changes block all writes; nothing is stashed or overwritten.
- Remote writes need a typed/explicit confirmation, a fresh remote verification, and are skipped if the remote moved.
- The API only answers `localhost` and requires a custom header, blocking cross-site/DNS-rebinding requests.
- The log redacts credentials in URLs, bearer tokens and any env secret values.

## Development

```bash
npm test          # Vitest: unit + integration tests against temporary local Git repos
npm run lint
npm run typecheck
npm run build
```

Layout: `src/server/git` (Git service), `src/server/providers` (GitHub, local demo), `src/server/workflows` (sync / transfer state machines), `src/server/api.ts` (validated route table), `src/components` (UI; type-only imports from the server).

## Known limitations

- GitHub only for PR APIs; Azure DevOps/other are git-only.
- "Unrelated change" detection is limited to merge commits and commits no longer on the PR head; it does not judge semantic relatedness.
- Patch strategy uses the PR's provider-reported base (falling back to the merge-base with org). If a PR merged a newer intern `develop` into itself, review the diff for unrelated intern changes.
- State is a local JSON file (single user, single machine); no database.
- Tests cover Git behavior against local bare repos and the GitHub client against mocked responses; there is no live GitHub integration test.
