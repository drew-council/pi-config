---
name: sembr
description: Write and reformat code comments with Semantic Line Breaks (https://sembr.org). Use when writing or editing code comments, doc comments (godoc, JSDoc, rustdoc), or docstrings in any language, or when asked to reflow text into semantic line breaks. Does not apply to Markdown unless explicitly asked.
disable-model-invocation: true
source:
  git: https://github.com/sembr/skills
  path: skills/sembr-reformat
---

## Writing Comments

Write new code comments and doc comments with semantic line breaks from the start.
Apply the SemBr rules above while drafting,
not as a later pass.

- New comment: use semantic line breaks.
- Edit inside an existing comment:
  match that comment's line-break style.
  If it is too short to tell, use semantic line breaks.
- Untouched comments MUST NOT be rewrapped.
  Keep the diff to the lines you changed.
- Never break compiler or lint directives (`//go:generate`, `//nolint:...`),
  URLs, tag lines (`@param`), license headers,
  or code examples inside comments.
- Doc renderers join lines with a space.
  Do not break right before or after an unspaced em dash.

`scripts/check.py` fails on any word change,
so run it only after a reformat-only pass,
never on comments you just wrote.

## Scope

Markdown and other prose files are out of scope
unless the user asks for a reformat.
Never apply semantic line breaks where a single newline renders as a visible break,
such as GitHub PR descriptions and comments.
