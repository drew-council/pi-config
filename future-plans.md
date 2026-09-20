factor out into separate extension for potential use by others
- agent/extensions/neovim-editor
    - most complex, needs cleanup and better robustness against general use
- agent/extensions/address-review-comments
    - should likely merge with agent/extensions/tuicr-review and expand a bit
- agent/extensions/review
- agent/extensions/git-conflicts.ts
    - needs cleanup, should have directory instead of one big file
    - should be gh-stack compatible

replace with skill+script:
- agent/extensions/gif-read-support along with agent/extensions/gif-read.ts
- agent/extensions/transcribe-audio

convert scripts to native pi scripts?

