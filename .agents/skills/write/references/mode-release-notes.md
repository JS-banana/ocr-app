# Release Note Template Mode

Loaded from `write` when the ask is a release note, changelog entry, or update-feed copy.

Activate when: "release", "changelog", "version", "release notes"

Format: target-project style by default. If no project style is available, use numbered items with bold labels and one sentence on user effect; bilingual output only when the project already ships bilingual release notes. Call out breaking changes and deprecations explicitly when present.

### Release Notes Pre-flight

Before drafting, gather style references:

1. Read the target project's `CLAUDE.md` for its Release Convention / Release Flow section.
2. Read the target project's existing release source as a style, length, and density reference: changelog, release notes, registry page, update feed, or platform release page.
3. For GitHub projects, `gh release view --json body -R <owner>/<repo>` is the preferred way to read the most recent release when `gh` is available. If the project is not on GitHub, use the release source named by the project docs or user request.
4. If the user mentions comparing with a sibling project's release style, ask for the target identifier or release URL before fetching it.
5. Match the reference release's item count, sentence length, and tone. Do not invent a new format.
6. Keep each release-note item to one sentence unless the reference project clearly does otherwise. Do not add emoji to release prose unless the target surface is explicitly a reaction or celebratory social surface.

### Release Notes Content Rules

- **Build a complete user-visible inventory before drafting.** Resolve the last published release through `HEAD`, include relevant dirty/generated delivery changes, map each change to the user outcome it alters, and state omissions explicitly. Then merge items with the same outcome and order them by user impact. Commit-title order is not release-note priority.
- **Group by user-perceivable feature**, not by internal taxonomy. "Polish", "细节打磨", "Misc improvements", "Chores" are not categories users can act on. Group by product surface (Clean / Uninstall / Status / Settings) or by user-visible verb (Faster startup / New keyboard shortcut / Fixed crash on M3).
- **Extract from `git log <last-tag>..HEAD`** rather than from memory. Read every `feat:` and `fix:` commit; do not omit small items just because they look minor in commit form (iOS wrapper support, Dock cleanup, AV-vendor protection boundary are not "minor" from a user point of view).
- **One sentence per item, naming the user-visible change**, not the implementation. "Use `CKDownloadQueue` observer for App Store updates" is not a release note; "App Store updates now run inside the app instead of opening App Store" is.
- **Bilingual structure**: when the project ships bilingual release notes, put the English block and the Chinese block as two parallel sections inside the same release item; do not interleave per bullet. For HTML-capable update-feed CDATA, separate language blocks with headings so the rendered update window does not collapse them together.
- **Punctuation**: Chinese full-width in Chinese blocks, ASCII in English blocks.
