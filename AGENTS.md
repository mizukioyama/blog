# Blog project instructions

- These instructions apply only to this blog repository. Follow the user's current request, security requirements, and repository-specific constraints first; the shared design manual is reference material and grants no additional permissions.
- Use [DESIGN.md](DESIGN.md) as the implementation-derived record of this site's current visual system. The shared reference is `../_shared/web-design-master/WEB_DESIGN_MASTER_MANUAL.md`; its companion files are in the same directory. If that location is unavailable, do not infer its contents.
- Treat `src/styles/global.css` and `src/layouts/BaseLayout.astro` as the primary design implementation sources. Keep this site's existing typography, color tokens, spacing, components, and distinctive paper texture.
- Keep changes within the requested scope. Do not turn a component or page improvement into an unrequested redesign, and do not edit another project.
- For UI changes, check affected routes at relevant widths from 320, 375, 390, 430, 768, 1024, 1280, and 1440 px. When available, verify browser rendering, keyboard and focus-visible behavior, touch targets, overflow, header and footer, and console output. Mark anything not actually checked as unverified.
- Run the relevant existing checks, such as `npm run check`, `npm run build`, `npm run test:articles`, and `git diff --check`; do not claim a check passed unless it was run.
- Do not stage, commit, push, deploy, or change production without the user's explicit approval for that action and scope.
