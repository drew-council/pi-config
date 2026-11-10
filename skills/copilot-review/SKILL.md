---
name: copilot-review
description: Address GitHub Copilot review comments. Use only when you actually see "GitHub Copilot" come up.
---

# Review Behavior

GitHub Copilot, in the `sheer` repository, automatically is requested for review when a PR is marked "Ready for review".
It can also be manually requested for review on a draft PR. Additionally, it can be re-requested to receive an updated review. Each review can be a bit expensive, so avoid over-requesting here. Usually, one review per PR is sufficient.

# Permissions

You are always authorized to reply to and resolve any bot comments, including those from GitHub Copilot.

# Guidance

In general, Copilot tends to be overly cautious and hyper-focused on potential edge cases, sometimes to the detriment of code quality, readability, and simplicity. Use dicernment when assessing if the comment is truly something to address, and always ask yourself "Is there a simpler way?"
Additionally, Copilot often cannot see follow-on code in the `gh-stack` on review. If it suggests something is unused or has no consumers, check that we don't have a later stack entry that does consume it.

