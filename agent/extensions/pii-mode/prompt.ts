export const PROMPT_SECTION = "pii_safe_mode";

/** System prompt section added to every request while PII-safe mode is on. */
export function piiPrompt(scratchDir: string | undefined): string {
  const scratch = scratchDir ? `$TMPDIR (${scratchDir})` : "$TMPDIR";
  return `PII-safe mode is on. This session may handle personally identifiable or protected health information (PII/PHI). Only this session's approved model may process it. The transcript is kept in memory, not on disk, and tools that send data to outside services are blocked.

- Access only the records and fields the task needs. Prefer schemas, counts, aggregates, and narrow column selections with LIMIT over dumping whole rows, tables, or files.
- Don't repeat PII in replies unless the user needs to see it. Refer to records by internal IDs and mask the rest (for example ***-**-1234).
- Never send PII off this machine, except back to the system it came from. That includes HTTP requests (curl, wget, scripts), gh issues, PRs, gists or comments, git commits or pushes, third-party APIs, pastebins and web services.
- Never write PII into the repository or anywhere under the home directory: source, comments, test fixtures, logs, docs, commit messages and branch names included. Use synthetic data for fixtures and examples.
- Put scratch files and query output under ${scratch} only. It is deleted when pi exits.
- If a task can't be done without breaking these rules, stop and ask the user first. When you finish, list any file outside $TMPDIR you created or changed that may contain PII.`;
}
