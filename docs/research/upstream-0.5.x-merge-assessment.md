# Upstream 0.5.x merge assessment

Research date: 2026-10-05. Branch assessed: `claude/eloquent-faraday-hvumf4` (HEAD `10ea5f90`) against the
original author's repository (`upstream`, chaitanyagiri/munder-difflin). Nothing was merged, committed or
checked out; the dry run below used `git merge-tree`, and `git status` is clean afterwards.

## Bottom line

- **We are not behind 0.5.5. We already have it.** The commit tagged `v0.5.5` (2 Oct) is an ancestor of our
  branch. Our fork split from upstream at `71dbbc18` on 4 Oct, which is 21 merges *after* the v0.5.5 tag.
- **Upstream has added only 9 commits since we split, all on 5 Oct, and every one of them is website
  content** (blog posts, blog images, a "motion graphics kit" for the blog, the sitemap). Not a single
  file under `src/`, `package.json` or `electron-builder.yml` changed upstream since we split.
- **The "0.5.x features" you have read about are in the paid Pro app, not in the open-source code.** The
  open repository's own version number is still `0.4.6` at the v0.5.5 tag and on `upstream/main` today.
  The 0.5.x tags are release markers for the website and the free installer; the headline features
  (Stapler meetings, the Pro sidebar, multiple floors, ticket keys, Remote Control from a phone) are
  shipped as closed binaries from harnessmd.com. There is no licence check in the open code because the
  Pro features are simply not there to gate. See `docs/research/pro-feature-inventory.md` for the
  feature-by-feature public descriptions.
- **The dry-run merge has zero conflicts.** Merging is safe and cheap; it also brings us nothing we would
  notice in the app.

How the numbers line up:

- `v0.5.5` = `41f900f5` (2 Oct), `upstream/main` = `70202a21` (5 Oct), our split point = `71dbbc18` (4 Oct).
- Commits upstream between our split point and `v0.5.5`: **0** (the tag is behind us).
- Commits upstream between our split point and `upstream/main`: **9**, touching 186 files, all under
  `blog/`, `docs/blog/`, `docs/pr-evidence/`, `docs/llms.txt`, `docs/sitemap.xml`.
- Commits on our side since the split: **16** (the custom work listed in section 2).
- Files changed on both sides: **0**. Dry-run merge conflicts: **0**.

## 1. What you would get

### From upstream/main today (the only thing actually new to us)

- Three new blog posts: "ASD-STE100 prompting" (Karpathy's four tricks), "How to use Claude Code", and
  the 4 Oct "Agent Tools Today" daily brief; refreshed copy on the Claude Code alternatives, OpenClaw
  alternatives, Codex-vs-Claude-Code, Conductor, context-engineering, plan-mode and Hermes posts.
- A shared "scene kit" (`kit.js`, `kit.css`, a cast image) for animated diagrams in blog posts, with a
  phone-sized layout and a fix so long comparison cells shrink instead of being cut off.
- Rebuilt static blog pages, feed, sitemap and `llms.txt`, plus three before/after screenshots.
- Nothing for the desktop app: no features, no fixes, no dependency changes, no translations.

### Already in your build: what upstream shipped between 0.4.6 and our split point

For orientation only; all of this is below our split point, so it is in the fork today. Items marked
**(Pro, closed)** are described in upstream's README/changelog but are *not* in the open code at any tag.

- Voice / dictation
  - Free Flow dictation into any app via Groq Whisper (open code). The **on-device English model in the
    installer** and macOS 26 Apple-engine dictation described for 0.5.3 are **(Pro, closed)**.
- Meetings
  - "Meetings hear both sides" in Stapler, screenshots and PDFs sent to an agent from Stapler:
    **(Pro, closed)**. Not present in the open tree at v0.5.5 or on `upstream/main`.
- Layout / UI
  - Task cards and the detail view show the task id (`bmt-12`).
  - Each agent's display name on a nameplate at its feet in the office scene.
  - Missing-CLI engines show as disabled rows in onboarding instead of vanishing.
  - The full Pro sidebar as a set of full-screen surfaces, ticket keys like `V53-299`, per-agent Tasks
    tab with date filter: **(Pro, closed)**.
- Agents / engines
  - New models in the pickers (Fable 5.1, GPT-6 Astra, Gemini 3.7 Flash) and a remote model catalog so a
    new model no longer needs a release.
  - Pi engine: bootstrap prompt and tool identity preserved across hook events.
  - Workers: stalled-worker nudging, "done" settles the inbox, archived-agent mail is filed and the sender
    told, hop-cap loop guard made real, crash tails capped and private.
  - Multiple floors (File, New Floor) exist behind a flag in the open code; "one licence covers them all"
    is **(Pro, closed)**.
- Integrations
  - Slack: socket timeouts on replies and downloads; Stop persists so boot does not re-arm.
  - GitHub/Codex hooks quoted correctly for paths with spaces; Codex Remote Control session named after
    the agent.
- Settings / platform
  - Stay Awake onboarding works on all platforms; malformed Claude config files are preserved with a
    warning; electron-builder pinned to a version that can package the app; tar advisory cleared.
- Fixes
  - Terminal: Shift+Enter inserts a newline; https links in agent output are clickable.
  - Hive: stale `HEAD.lock` cleared, git auto-gc no longer outlives its commit, malformed outbox lines
    recovered, generated docs not rewritten at runtime, standing goals injected only when changed.
  - Website: 103 people's payment ids removed from the public wall data.

## 2. Overlap with what this fork already has

Because upstream's open code has not moved since we split, there is nothing in the merge that touches our
custom work. The comparison the owner actually cares about is our work versus the **closed Pro build**,
which we cannot merge from anywhere:

- **Stapler meeting transcription** (ours: `src/main/stapler.ts`, `src/shared/stapler.ts`,
  `src/renderer/src/stapler/*`, `StaplerTab.tsx`, floating `staplerWindow.ts`): **duplicates the Pro
  feature in intent**, but ours is the only source code we have. Upstream's version is not merge-able.
- **Office sidebar layout** (`OfficeSidebar.tsx`, `repoGroups.ts`, `SidebarSplitter.tsx`, `layoutMode`):
  upstream's open commit `13bc79f3` is the same rail we built on; the full Pro "surfaces" are closed.
  **Complements** what is open; no conflict.
- **Export / Import office** (`officeMove.ts`, `OfficeMoveSection.tsx`): no upstream equivalent, open or
  Pro. **Unique to us.**
- **Slack Socket Mode** (`slackSocket.ts`, `ws` dependency): no upstream equivalent. **Unique to us.**
  Upstream's Slack timeouts (already in our base) sit underneath it without overlap.
- **Realtime voice tuning** (`realtime/turnTaking.ts`, `filler.ts`, `session.ts`, voice picker,
  `realtimeVoices.ts`): no upstream equivalent. **Unique to us.**
- **Showcase** (`showcase.ts`, `ShowcaseTab.tsx`, `cth-showcase` protocol): no upstream equivalent.
  **Unique to us.**
- **Terminal path links on a plain click, Windows fixes** (`terminalPool.ts`, `terminalPaths.ts`,
  `openTerminal.ts`): **complements** upstream's https-link fix, which is already in our base.
- **Hire dialog free-text model id**: complements upstream's remote model catalog (already in base).
- **Updater pointed at markhiltonapps** (`updater.ts`, `electron-builder.yml`, `package.json`): a
  deliberate, permanent divergence. Upstream did not touch these files since the split.
- Also ours: startup smoke test (`tools/smoke-startup.cjs`), quit confirmation and teardown deadline,
  the "talk" toggle in Command Center and the agent panel, and eight new test files.

## 3. Merge risk

- Files both sides touched since the split: **none**. The big files you asked about
  (`src/main/index.ts`, `src/main/hive.ts`, `App.tsx`, `SettingsModal.tsx`, the `en`/`zh-CN`/`ar`
  locales, `package.json`, `electron-builder.yml`, `store.ts`) were changed only by us. Reconciling
  effort for each: **low (nothing to reconcile)**.
- Dry run: `git merge-tree --write-tree HEAD upstream/main` produced a clean tree
  (`af59f648...`) with **0 conflicts**. `git status --short` is empty afterwards.
- The only practical consideration is bulk: the merge adds roughly 7,900 lines of generated blog HTML
  and about 40 PNGs under `docs/`. That matters only if the fork serves its own website from `docs/`;
  the desktop app does not read any of it.
- Residual risk is near zero: no source, no dependencies, no build config, no translations change.

## 4. Recommendation

- **Merge `upstream/main` in one go, or skip it.** There is no reason to cherry-pick: every upstream
  commit is website content and none conflicts. If you do not publish upstream's blog from this fork,
  skipping costs you nothing in the app.
- **Effort: under half a day**, including a build and the startup smoke test. Most of that is just
  running checks.
- **Keep everything of ours.** No upstream feature exists in the open code that would replace Stapler,
  the sidebar, Showcase, office move, Socket Mode or the voice tuning. The Pro versions of Stapler and
  the sidebar are closed and cannot be adopted.
- **Re-test after merging** (if you merge): `npm run build`, `npm run smoke:startup`, and the existing
  test suite. Nothing in the app changes, so this is a confirmation run rather than a hunt.
- **Two housekeeping points worth deciding separately:**
  - Our `package.json` still says `0.4.6` while upstream markets `0.5.3`/`0.5.5`. Since our updater now
    polls markhiltonapps releases, pick a version scheme of our own (for example `0.4.6-mh.1` or
    `0.5.0`) so release notes and the updater are not confused with upstream's numbering.
  - Set a light routine to `git fetch upstream` monthly and re-run the same dry-run (`git merge-tree
    --write-tree HEAD upstream/main`). Upstream's open code has been fixes-only since late August;
    if that changes, the dry run will say so before anyone spends a day on it.
