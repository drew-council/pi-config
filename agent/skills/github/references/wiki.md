# Wiki

The wiki is a git repository, `sheerhealth/sheer.wiki.git`, of about 90 flat markdown pages. There is no API for page content, so `sheer-gh wiki` keeps a clone under `~/.cache/sheer-wiki` and reads from it. A page named `Git Worktrees` is the file `Git-Worktrees.md` and the URL `https://github.com/sheerhealth/sheer/wiki/Git-Worktrees`.

## Commands

```sh
sheer-gh wiki list                          # page titles
sheer-gh wiki search "bazel cache"          # pages with matching lines
sheer-gh wiki show "production release process"   # prints the markdown; name is case-insensitive
sheer-gh wiki path "git worktrees"          # local file path
sheer-gh wiki sync                          # force a pull; commands sync on their own once a day
```

`show` accepts a prefix or substring and lists the matches when the name is ambiguous.

## Pages worth knowing

- Project Management. How issues, the board, and triage work.
- Pull Request Guidelines. Title, sizing, drafts, reviewers.
- Production Release Process and Production Hotfix Release Process.
- CI-CD, Troubleshooting Builds, Setting up Build Boxes for GitHub CI.
- First time Dev Setup, Git Worktrees, Running services locally, Useful Bazel Commands.
- Azalea Developer Guide and the other Azalea pages for the scraping service.
- Home. The index; every page should be linked from a section there.

## Editing

Edit the file in the clone, commit, and push to the wiki remote. Confirm with the user first; a push is live immediately. Keep pages short and single-topic, and add a `[[Page Name]]` link under the right section of `Home.md` when creating a page.
