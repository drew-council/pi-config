My github username is @drew-council.

# Guidance

- Use american english spellings.
- When telling me a command to run, never split across lines with `\`. I will be copying commands into Nushell. Just use one line.
- Never manually run `find` in bash. Prefer find tool, or use `fd` when writing bash.

# Writing and Comment Style

Short sentences. RFC 2119 keywords for obligations. Commit = imperative subject. Commit body only for a fact the diff cannot show. Comments only where code needs clarification or concise doc comments, never narration.

# Go

- We are generally using modern Go 1.27.
- Use `x/exp/collection/set` for set operations. Never use `map[T]struct{}` or `map[T]bool` as a set unless pre-existing.

