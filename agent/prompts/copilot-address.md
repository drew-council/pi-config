---
description: Address all GitHub Copilot comments across the stack.
---

View the active `gh-stack`, take a look at all PRs.
For each PR, look for GitHub copilot bot comments, and determine if each is relevant. For the relevant ones, you should resolve them in one or more commits to the relevant branch(es). You may reply to them and resolve them.

In general, Copilot tends to be overly cautious and hyper-focused on potential edge cases, sometimes to the detriment of code quality, readability, and simplicity. Use dicernment when assessing if the comment is truly something to address, and always ask yourself "Is there a simpler way?"
Additionally, Copilot often cannot see follow-on code in the `gh-stack` on review. If it suggests something is unused or has no consumers, check that we don't have a later stack entry that does consume it.

DO NOT engage with any human (non-copilot) comments at all.

