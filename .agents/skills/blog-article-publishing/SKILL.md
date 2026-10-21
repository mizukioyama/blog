---
name: blog-article-publishing
description: Use when the user asks to write, plan, revise, or locally preview an article for Mizuki Oyama Journal, including short requests such as “〇〇について記事を書いて”. Create a private Draft, verify its facts and metadata, and stop at Review. Never publish or mark Approved without the user’s explicit content approval.
---

# 独自ブログ記事制作

記事の企画・文章品質・アイキャッチの編集基準は [docs/ARTICLE_WRITING_RULES.md](../../../docs/ARTICLE_WRITING_RULES.md) を正本として参照してください。このSkillはブログ固有の実行手順と安全ゲートを定めます。

## Scope and safety

- Work only in the blog repository. Before writing, verify that git rev-parse --show-toplevel identifies the checkout and git remote get-url origin equals https://github.com/mizukioyama/blog.git. If the repository identity or local access cannot be confirmed, stop and request local access; do not substitute a mirror, another blog, yurayura, yurayura-line-os, or website.
- Preserve all pre-existing tracked and untracked changes. Read `git status --short` first. During article creation and review, keep the article in `.private-drafts/<draft-id>/` with `draft: true` and do not edit `src/content/blog` or perform GitHub operations. The only publication path is the explicit Phase 2B workflow below.
- The user’s theme and supplied notes are enough to begin. Ask a follow-up only when a missing personal experience or material fact cannot be safely left as an open question.
- Never change a draft to `Approved` before the user has reviewed it and explicitly approved its content. `Approved` is separate from GitHub or publication approval.

## Create the article

1. Read relevant published posts and drafts to check overlap and understand the blog's existing voice. Apply the editorial standard in `docs/ARTICLE_WRITING_RULES.md`; do not copy existing sentences. Select `Art`, `Exhibition`, or `Creative` based on the subject.
2. Create a private draft without prompting the user for terminal input:

   `npm run article:new -- --topic "<theme>" --notes "<user notes>" --category <Art|Exhibition|Creative>`

   Record the returned `draft-id`. The command creates `brief.md` and an initial `index.md` atomically.
3. Record user-supplied facts, sourced facts, suggestions, and unanswered questions distinctly in brief.md. For note migration record whether the full source was accessible, URL and central theme, concrete events and author wording retained, omissions and reasons, basis for added interpretation, and unavailable or unverified items. Never reconstruct inaccessible source facts. Keep note date separate from planned blog date. For changing facts, record primary source title, URL, access date, and supported claim. For exhibition posts, verify dates, participants, venue, exhibition details, and organizer impressions; unresolved material facts keep the article at Draft.
4. Apply the editorial standard to the title, opening, headings, body, and links. Choose Art for making/expression/creative decisions, Exhibition for planning/venue/viewing/operation, or Creative for Web/AI/tools/technical experiments by central value; ratios are not quotas. seoTitle may be omitted in Draft/Review under the current validator, but candidate preparation requires it (70 characters or fewer). Set the 40–160 character description, unique lowercase-hyphen slug, category, and tags. Use confirmed information and remove template text.
   During Draft, check that the prose sounds natural, follows the source facts, avoids repeated transitions and unnecessary headings or lists, and uses a structure suited to the article. Do not judge voice through a mechanical forbidden-phrase list.
5. Design the cover with the article. Record its concept, visual direction, 1200×630 target, descriptive alt, source/rights, and filename in brief.md. Note publication on note does not grant blog reuse rights. Distinguish real artwork, venue, and app screenshots from generated or illustrative imagery; align alt with visible content and article meaning. If generating, do not reuse or alter existing artwork or photos. If the generated file is outside the OS temporary folder, copy it unchanged into an operating-system temporary directory, then save it with npm run article:asset -- <draft-id> <temporary-image-path> <cover.png>. Save only an actual generated file. If no local image file can be obtained, leave cover/ogImage unset and report the image spec.
6. Save the article and updated brief through the atomic workflow command, not by truncating `index.md` directly. Send JSON on standard input:

   `npm run article:save -- <draft-id> <<'ARTICLE_JSON'`

   Provide an object with `data` (frontmatter fields), `content` (Markdown body), and `brief` (complete fact and image notes), then close the heredoc with `ARTICLE_JSON`. The command forces `draft: true` and `workflowStatus: Draft`, validates paths and metadata, and leaves the existing article intact if validation fails.
7. Run `npm run article:validate -- <draft-id>`. Resolve validation errors. When there are no unresolved material facts, move to `Review` with `npm run article:status -- <draft-id> Review`. The review validator checks article length, headings, frontmatter, image paths, and alt text.
   Before moving to Review, reread the full article as an editor: verify the title, opening, flow, tone, repeated wording, claims, links, SEO, and image meaning against docs/ARTICLE_WRITING_RULES.md. Automated validation does not replace this editorial check; keep unresolved material facts at Draft.
8. Run `npm run article:preview -- <draft-id>`. It binds only to `127.0.0.1`; keep the server running for the user and report the exact URL it prints. Inspect the preview in a browser when available: title, body, cover, category, SEO/OGP tags, sticky header, mobile menu, Footer, and responsive layout. If browser control is unavailable, report that clearly and provide the local URL.
9. Report the draft ID, category, SEO fields, fact gaps, image-generation result or fallback spec, validation result, preview URL, and files saved. Stop at `Review` and wait for the user’s review.

## Revisions and content approval

- Before revising an existing draft, create a local snapshot: `npm run article:backup -- <draft-id>`. Keep and report the returned backup ID. Move a `Review` draft back to `Draft` before saving revisions. The save operation atomically replaces each validated file and does not change public content.
- To restore, use `npm run article:restore -- <backup-id> [new-draft-id]`. Restore refuses to overwrite an existing folder. Run article validation after recovery.
- Backups remain local in the ignored `.private-draft-backups/` directory. Do not upload drafts or backups to any external service. If the user has Time Machine or an encrypted external disk configured, recommend including the local backup folder there; do not alter backup settings.
- Only after an explicit user message approving the article content may you run `npm run article:status -- <draft-id> Approved --user-confirmed`. This records content approval only. It is separate from permission to place files, stage, commit, push, run Actions, or publish.


## Phase 2B｜承認付き公開フロー

The complete operational runbook is [docs/ARTICLE_PUBLICATION_WORKFLOW.md](../../../docs/ARTICLE_PUBLICATION_WORKFLOW.md). Apply it together with this Skill; it does not weaken any safety gate above.

1. After an article reaches `Review`, run `npm run article:publish:prepare -- <draft-id>`. This validates required metadata and assets, duplicate slugs/titles, local blog routes, path safety, and obvious private-path/secret markers. It writes only a hash-bound candidate under ignored `.private-publication/`; it does not edit the public content collection or the source draft. A missing SEO title, cover, brief, unsafe link/image, unresolved brief marker, or validation error blocks the candidate.
2. Show the user the exact title, full article, image, SEO/OGP/Twitter details, planned date, URL, file allowlist, candidate SHA-256, and unresolved/manual checks. Ask for the local preview to be reviewed when available. Semantic overlap, facts, rights, tone, links, and image meaning still require editorial review.
3. Treat content approval and GitHub publication approval as two distinct permissions. The user must explicitly approve the exact candidate content and, separately, its GitHub Pages publication. An `Approved` state, `--user-confirmed`, or `--candidate-sha` alone is never proof of either conversation approval. If the user approves only the content, keep it private and do not materialize or perform Git/GitHub operations.
4. Only after both approvals, record `Approved`, run the materialization dry-run with the exact candidate SHA, inspect its exact file list, then materialize that same candidate. This creates new public source files without moving or deleting the private draft, images, brief, or backup. A changed draft, mismatched hash, duplicate slug, or occupied destination must stop without overwriting.
5. Run the article tests, Astro check, production build, and diff check. Preserve unrelated unstaged work and stop if unrelated staged changes exist. After explicit stage permission, stage only the candidate target files. Inspect the staged names and diff, then run npm run article:publish:check-git-scope -- <plan-id> --candidate-sha <sha256> --phase index. This read-only gate derives paths and hashes from the saved plan and both receipts; it does not accept a caller-supplied allowlist or stage files. Only after the gate passes and commit permission is confirmed, create one article commit.
6. Before push, refresh origin/main, then run the same gate with --phase commit. It requires the single commit parent to match the fetched origin/main, and the commit tree changes and blob hashes to match the candidate exactly. Check push permission separately and use a normal push only when explicitly authorized. .github/workflows/deploy.yml is manual workflow_dispatch; a push does not deploy. Check whether the same SHA already has a run, dispatch the existing workflow once if needed, and verify build/deploy success plus SHA equality. Then run npm run article:publish:verify with the confirmed run details. Preserve all work on failure; never reset, clean, or delete the candidate or draft.

Receipt writes use a same-directory mode-0600 temporary file, flush it, and atomically create the final name with fs/promises.link() so an existing receipt is never overwritten. Temporary files are not approvals. Identical retries are no-ops; conflicting or corrupt records stop. The link approach requires same-filesystem hard-link support and does not claim cryptographic user identity. A receipt records Codex’s trace of an explicit conversation approval; it is not identity proof.
7. Record verified publication metadata privately in the plan directory. Use real available metrics only for the 12h/24h follow-up; browser layout and console checks must be performed separately and marked `NOT_TESTED` when unavailable.
