# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `stepanosokin/gis-platform`.
Use the `gh` CLI from this repository; infer the repo from `git remote -v`.
If the sandbox proxy blocks `gh`, use the GitHub connector to read the issue and its comments.

## Conventions

- Create: `gh issue create --title "..." --body-file <file>`.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,body,labels,comments`.
  Add label and state filters as needed.
- Edit: `gh issue edit <number> --title "..." --body-file <file>`.
- Comment: `gh issue comment <number> --body-file <file>`.
- Add or remove labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.

For multiline bodies, write the exact Markdown to a temporary UTF-8 file
and pass it with `--body-file`, preserving actual newlines.

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", read the corresponding issue.

## Ticket acceptance and closure

1. Before implementation, check that the environments and data required by the acceptance criteria are available. Surface any gap early. The selected test level determines the scope of new tests.
2. After verification, update the issue checklist and record what ran and where. If the user agrees to change a criterion, record the revised criterion and any assumptions in the issue.
3. Close the issue when all agreed criteria are checked. Read back the issue state before reporting completion. If a criterion remains open, report it with the evidence still needed.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Wayfinding operations

The map is one issue; its child issues are tickets.

- Map: label it `wayfinder:map`; keep Notes, Decisions-so-far, and Fog in its body.
- Child ticket: use `wayfinder:<type>`, where type is `research`, `prototype`,
  `grilling`, or `task`. Link it as a native sub-issue:
  `gh api --method POST repos/{owner}/{repo}/issues/<map>/sub_issues -F sub_issue_id=<child-db-id>`.
  If sub-issues are unavailable, add the child to a task list in the map and
  put `Part of #<map>` at the top of the child's body.
- Blocking: use native issue dependencies:
  `gh api --method POST repos/{owner}/{repo}/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`.
  Obtain database IDs with `gh api repos/{owner}/{repo}/issues/<number> --jq .id`.
  If dependencies are unavailable, put `Blocked by: #<number>, #<number>`
  at the top of the child's body. A ticket is unblocked when all blockers close.
- Frontier: inspect the map's open children in map order. Skip assigned tickets
  and tickets with open blockers. Native `issue_dependencies_summary.blocked_by`
  counts open blockers; otherwise inspect the fallback references.
- Claim: `gh issue edit <number> --add-assignee @me`; this is the session's first write.
- Resolve: comment with the answer, close the ticket, and append a brief
  context pointer with its link to the map's Decisions-so-far.
