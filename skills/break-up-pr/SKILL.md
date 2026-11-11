---
name: break-up-pr
description: Break up a large PR into reviewable smaller PRs stacked in gh-stack.
disable-model-invocation: true
---

# Guidelines

PRs should remain small, reviewable, and independently mergeable. The following are guidelines you should try to hit. Use your discretion for cases where it makes sense to violate them.

- Each PR should be a reasonable length: For backend Go PRs, <800 LOC. For frontend React/TS PRs, <1100 LOC. Do NOT include generated code in these counts (based on `.gitattributes`).
- Each PR should tackle ideally one discrete, clear portion of functionality. It should try to be single-minded so a reviewer can follow it logically.
- Each PR should be able to merge onto `main` independently, ideally without depending on follow-on PRs in the stack.
- Often, frontend and backend are in separate PRs so that the appropriate reviewers can look at each without approving both. With large changes, it also often makes sense to separate out API changes as well.
- DB schema changes are always in a separate PR from consumers of that schema change. DB schema changes must be released before any PR that consumes them is merged.

# Rules

- Do NOT add code comments intended for reviewers to read. Code comments are for future readers of code and are NEVER specific to the nuances of a given PR. Do not compare to replaced code or similar.
- Do NOT make PR stacks with more than 25 entries. Those can get extremely unwieldy to manage. Try to keep stacks below 10 entries if reasonable within guidelines.

