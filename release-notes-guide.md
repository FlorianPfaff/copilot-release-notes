# Desktop Release Notes Style Guide

## Categories

Prefix each entry with one of these tags:

- `[New]` — Reserved for the most significant new features. Use sparingly — these are release highlights.
- `[Added]` — Smaller features, new commands, or discrete additions
- `[Fixed]` — Bug fixes. Describe what works now, not what was broken.
- `[Improved]` — Enhancements to existing features that weren't necessarily broken
- `[Removed]` — Removed functionality (rare)

**Rule of thumb:** Small new end-to-end feature → `[Added]`. Change to a portion of an existing feature → `[Improved]`.

## What to Skip

Do NOT generate entries for:
- CI/CD configuration changes
- Test-only changes
- Internal refactoring with no behavior change
- Build system or developer tooling updates
- Dependency bumps (unless fixing a security vulnerability or changing user-visible behavior)

## Writing Style

1. **Write for users, not developers** — describe impact on users, not implementation details
   - ✅ "Keep PR badge on top of progress bar"
   - ❌ "Increase z-index of the progress bar PR badge"

2. **Use present tense**
   - ✅ "Add external editor integration for Xcode"
   - ❌ "Adding external editor integration for Xcode"

3. **Description must be readable without the tag** — it should make sense on its own
   - ✅ "[Improved] Always fast forward recent branches after fetch"
   - ❌ "[Improved] Branch fast-forwarding after fetch"

4. **For [Fixed] entries, describe what works now**
   - ✅ "Keep conflicting untracked files when bringing changes to another branch"
   - ❌ "Conflicting untracked files are lost when bringing changes to another branch"

5. **Be specific but concise** — aim for 10-100 characters

## External Contributors

If a PR author is NOT a member of the `desktop` GitHub org, append attribution:
```
[Tag] Description - #issue_ref. Thanks @username!
```

## Issue References

- If the PR body has `Closes/Fixes/Resolves #NNN`, use those issue numbers: `- #1234 #5678`
- Otherwise, use the PR number: `- #NNNN`

## Uncertainty

If you cannot confidently determine the tag, use `[???]` to flag it for human review.
