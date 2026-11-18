# GitHub issue tracker

Use `gh` for issues and specs in `jaredbob/oura-sleep-metrics`. Before creating issues, verify the target with `gh repo view --json nameWithOwner`. If the inferred target differs, use `--repo jaredbob/oura-sleep-metrics`.

## Issue operations

- To publish a spec or ticket, run `gh issue create --title "..." --body-file <file>`.
- To fetch a ticket, run `gh issue view <number> --json number,title,body,labels,comments`.
- To list issues, run `gh issue list --json number,title,body,labels,comments` with the appropriate `--state` and `--label` filters.
- To comment, run `gh issue comment <number> --body-file <file>`. When closing, post the explanation first and then run `gh issue close <number>`.
- To change labels, run `gh issue edit <number> --add-label <label>` or `gh issue edit <number> --remove-label <label>`.

## Sub-issues and dependencies

- Link a new child with `gh issue create --parent <parent> ...` or an existing child with `gh issue edit <parent> --add-sub-issue <child>`. If sub-issues are unavailable, put `Part of #<parent>` at the top of the child body.
- Record dependencies with `gh issue create --blocked-by <n>,<n> ...` or `gh issue edit <child> --add-blocked-by <blocker>`. If native dependencies are unavailable, put `Blocked by: #<n>, #<n>` at the top of the child body.
- Count open blockers with `gh api repos/{owner}/{repo}/issues/<number> --jq .issue_dependencies_summary.blocked_by`. For a `Blocked by:` line, check that every listed issue is closed.

## Pull requests as a triage surface

**PRs as a request surface: no.**

If set to `yes`, use the same triage roles for external pull requests. Read with `gh pr view <number>`, `gh pr view <number> --comments`, and `gh pr diff <number>`. List open pull requests with `gh api --paginate 'repos/{owner}/{repo}/pulls?state=open'` and select those whose author association is outside `OWNER`, `MEMBER`, and `COLLABORATOR`. Use `gh pr comment`, `gh pr edit`, and `gh pr close` for triage. Issues and pull requests share a number space. Resolve an ambiguous number with `gh pr view`, then `gh issue view` if needed.

## Wayfinding operations

- Create a map issue with the `wayfinder:map` label. Its body holds Notes, Decisions-so-far, and Fog.
- Add each ticket as a sub-issue and apply its `wayfinder:<type>` label (`research`, `prototype`, `grilling`, or `task`). If sub-issues are unavailable, add the ticket to the map body's task list and include `Part of #<map>` in the ticket body.
- Select the first open, unassigned child in map order with zero open blockers.
- Claim the issue with `gh issue edit <number> --add-assignee @me` before starting work.
- Post the answer, close the child, and append a summary with the issue link to the map's Decisions-so-far.
