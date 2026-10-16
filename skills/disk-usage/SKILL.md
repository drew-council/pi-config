---
name: disk-usage
description: Analyze disk usage with `dua` to find what is taking up space. Use when asked about disk space, large directories, or what to clean up.
---

# Disk usage

Never use `du`; it is significantly slower than `dua`.

Use `dua aggregate` (alias `dua a`). Never run `dua interactive`/`dua i` or `dua clean`; they are TUIs and fail without a terminal.

```bash
dua a <path>...           # one line per entry in each path (defaults to cwd entries), plus a total
dua a -d 2 <path>         # indented tree, 2 levels deep (inputs are level 1)
```

Output is sorted ascending by size, so the largest entries are at the bottom. Pipe through `tail` to trim long listings.

Useful flags:

- `-x`: don't cross filesystems or mount points. Use when scanning `/` or `~`.
- `-i <abs-dir>`: skip a directory reached during traversal (e.g. `-i /System/Volumes`).
- `-A`: apparent size instead of on-disk size.
- `-f gib|mib|bytes`: fixed units, handy for comparing or parsing.

Start shallow and drill into the largest entries rather than scanning deep trees at once. Report findings; don't delete anything without confirmation.
