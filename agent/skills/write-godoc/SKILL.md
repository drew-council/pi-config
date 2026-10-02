---
name: write-godoc
description: Writes and reviews Go doc comments, the comments above a package clause or a top-level const, func, type, or var, following go.dev/doc/comment and keeping each one to what a caller needs. Use when adding or changing an exported Go declaration, a package comment, or a .proto message, field, or rpc, or when reviewing or shortening doc comments.
---

# write-godoc

Write concise doc comments that tell a caller what they need. Review in this repo cuts far more doc comment text than it asks for.

[references/go-doc-comments.md](references/go-doc-comments.md) is the Go project's guide, go.dev/doc/comment. Before writing, you must read its section for the kind of declaration: Packages, Commands, Types, Funcs, Consts, or Vars. Read its Syntax section before using links, lists, headings, or code blocks.

## What to write

- Describe what a caller can observe: what a func returns or does, what one instance of a type represents, the special cases, and the errors a caller can check for. Leave out how the code works.
- Write for a reader of the merged code. Leave out the change that produced the comment, the discussion behind it, the code it replaced or mirrors, and the designs not chosen.
- Describe what the code does, not what it doesn't do or does "rather than" something else.
- Say each thing once, on the declaration it describes. A field's details go on the field and a type's on the type, never in the package comment.
  - Don't repeat a .proto comment on the Go code that serves it.
- Put a TODO beside the code it's about and a `//nolint` reason on the directive's line, not in the doc comment.

## Examples

Each pair documents the same declaration twice.

### What the caller observes

**Bad example: implementation, what it doesn't do, and a rejected design**

```go
// Decide records the admin's decision. It does not run the tool. Await polls Redis every
// 500ms, sees the decision, and the agent runs the tool. Decide writes with a Lua script
// rather than WATCH/MULTI so the check and the write are atomic.
func (s *Store) Decide(ctx context.Context, callID string, d Decision) error
```

**Good example: the effect and the error a caller can check**

```go
// Decide delivers d to the [Store.Await] call waiting on callID. It returns [ErrNotPending]
// if no call is waiting on callID.
func (s *Store) Decide(ctx context.Context, callID string, d Decision) error
```

### The merged code, not its history

**Bad example: the code it ports and the review behind it**

```go
// standardizeName ports Python's standardize_name. It flips "Last, First" to "First Last".
// Python drops anything after the second comma, and per review we kept that instead of
// returning an error.
func standardizeName(name string) string
```

**Good example: the special cases the signature can't show**

```go
// standardizeName rewrites "Last, First" as "First Last" and drops anything after a second
// comma. It returns any other name with surrounding space trimmed.
func standardizeName(name string) string
```

### Each detail on its own declaration

**Bad example: field details in the type's comment**

```go
// A Reply is one item in the stream that answers a message. Delta holds a chunk of text the
// agent is still writing. Deltas have no ID because they are not stored, so append each one
// to a draft. Message holds the complete answer and replaces the draft.
type Reply struct {
	Delta   string
	Message *Message
}
```

**Good example: the stream on the type, each field on the field**

```go
// A Reply is one item in the stream that answers a message. A text answer arrives as zero or
// more replies with Delta set, then one with Message set.
type Reply struct {
	// Delta is the next chunk of the answer. Append it to the draft of earlier chunks.
	Delta string

	// Message is the complete answer. It replaces the draft.
	Message *Message
}
```

## Syntax

Indentation decides the structure, and gofmt rewrites a comment to match what it parsed.

- Link to symbols with `[Name]`, `[pkg.Name]`, or `[*pkg.Type]`. Doc comments have no inline code syntax, so write parameter names and other identifiers without backquotes.
- An indented line starts a code block. Don't indent the continuation of a wrapped sentence, and do indent the continuation of a list item.
- Lists can't nest.
- Put a directive such as `//go:embed` last, after an empty `//` line.

## Check

1. Reread each sentence against "What to write" and delete the ones that fail.
2. Run `go doc -all ./<pkg>`, or `go doc ./<pkg>.<Symbol>` for one symbol, and read the output. Add `-u` for unexported names. Text rendered as a code block, or list items run together, means the indentation is wrong.

## In this repo

- The `godot` linter requires a comment on a top-level declaration to end with a period.
- Comments on .proto messages, fields, and rpcs follow the same rules. The code generators copy them into the generated Go and TypeScript.
- By default, document a Go package in its package comment, not a new README.md.

