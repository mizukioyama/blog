---
name: blog-article-publishing
description: Use when the user asks to write, plan, revise, or locally preview an article for Mizuki Oyama Journal, including short requests such as “〇〇について記事を書いて”. Create a private Draft, verify its facts and metadata, and stop at Review. Never publish or mark Approved without the user’s explicit content approval.
---

# 独自ブログ記事制作

## Scope and safety

- Work only in the blog repository. Before writing, verify that git rev-parse --show-toplevel identifies the checkout and git remote get-url origin equals https://github.com/mizukioyama/blog.git. If the repository identity or local access cannot be confirmed, stop and request local access; do not substitute a mirror, another blog, yurayura, yurayura-line-os, or website.
- Preserve all pre-existing tracked and untracked changes. Read `git status --short` first. Do not edit `src/content/blog`, stage, commit, push, run GitHub Actions, or publish. Keep the article in `.private-drafts/<draft-id>/` with `draft: true`.
- The user’s theme and supplied notes are enough to begin. Ask a follow-up only when a missing personal experience or material fact cannot be safely left as an open question.
- Never change a draft to `Approved` before the user has reviewed it and explicitly approved its content. `Approved` is separate from GitHub or publication approval.

## Create the article

1. Read the existing published article `src/content/blog/exhibition/yurayura-first-group-exhibition-report/index.md` for voice and structure. Do not copy its sentences. Select `Art`, `Exhibition`, or `Creative` based on the subject.
2. Create a private draft without prompting the user for terminal input:

   `npm run article:new -- --topic "<theme>" --notes "<user notes>" --category <Art|Exhibition|Creative>`

   Record the returned `draft-id`. The command creates `brief.md` and an initial `index.md` atomically.
3. Separate information into (a) statements supplied by the user, (b) facts verified from reliable sources, and (c) suggestions or unanswered questions. For changing facts, browse current primary sources and put source title, URL, access date, and the supported claim in `brief.md`. For exhibition posts verify dates, participating artists, venue, exhibition details, and organizer impressions. Never invent a personal experience or infer missing event details. If any material fact remains unresolved, leave it clearly marked in the brief and keep the article at `Draft`.
4. Write the title, a concise SEO title (70 characters or fewer), a 40–160 character description, a valid unique lowercase-hyphen slug, category, tags, and a complete Japanese Markdown article with useful `##` headings. For a real article, use only verified facts and the user’s actual statements. Do not retain template text.
5. Design the cover at the same time as the article. Record in `brief.md`: concept, visual direction, optional copy, 1200×630 target size, descriptive alt text, and a safe filename. If image generation is available, create an original image that does not reuse or alter existing artwork or photographs. If the returned generated file is outside the OS temporary folder, copy it unchanged into an operating-system temporary directory first, then save it with `npm run article:asset -- <draft-id> <temporary-image-path> <cover.png>`. Save only an actual generated file. If no local image file can be obtained, keep the image specification in the brief and leave `cover`/`ogImage` unset; never claim an image was generated.
6. Save the article and updated brief through the atomic workflow command, not by truncating `index.md` directly. Send JSON on standard input:

   `npm run article:save -- <draft-id> <<'ARTICLE_JSON'`

   Provide an object with `data` (frontmatter fields), `content` (Markdown body), and `brief` (complete fact and image notes), then close the heredoc with `ARTICLE_JSON`. The command forces `draft: true` and `workflowStatus: Draft`, validates paths and metadata, and leaves the existing article intact if validation fails.
7. Run `npm run article:validate -- <draft-id>`. Resolve validation errors. When there are no unresolved material facts, move to `Review` with `npm run article:status -- <draft-id> Review`. The review validator checks article length, headings, frontmatter, image paths, and alt text.
8. Run `npm run article:preview -- <draft-id>`. It binds only to `127.0.0.1`; keep the server running for the user and report the exact URL it prints. Inspect the preview in a browser when available: title, body, cover, category, SEO/OGP tags, sticky header, mobile menu, Footer, and responsive layout. If browser control is unavailable, report that clearly and provide the local URL.
9. Report the draft ID, category, SEO fields, fact gaps, image-generation result or fallback spec, validation result, preview URL, and files saved. Stop at `Review` and wait for the user’s review.

## Revisions, backups, and approval

- Before revising an existing draft, create a local snapshot: `npm run article:backup -- <draft-id>`. Keep and report the returned backup ID. Move a `Review` draft back to `Draft` before saving revisions. The save operation atomically replaces each validated file and does not change public content.
- To restore, use `npm run article:restore -- <backup-id> [new-draft-id]`. Restore refuses to overwrite an existing folder. Run article validation after recovery.
- Backups remain local in the ignored `.private-draft-backups/` directory. Do not upload drafts or backups to any external service. If the user has Time Machine or an encrypted external disk configured, recommend including the local backup folder there; do not alter backup settings.
- Only after an explicit user message approving the article content may you run `npm run article:status -- <draft-id> Approved --user-confirmed`. This records content approval only. Do not stage, commit, push, deploy, or publish as part of this skill.
