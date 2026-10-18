# Mizuki Oyama Journal — Design reference

This document records the current design from the implementation. It is not a second token system. When it differs from the rendered implementation, inspect the source files and use their current computed behavior as the source of truth.

## Purpose and direction

The blog records artwork, exhibitions, and making things with the web and AI. Its current presentation uses a light paper ground, a faint layered paper texture, restrained gray and muted accent colors, fine dividing lines, Japanese serif typography, and generous spacing. Preserve this character when making scoped improvements; do not expand a partial request into a redesign.

## Source of truth

- Global visual rules and responsive overrides: `src/styles/global.css`
- Shared page shell, navigation, metadata, and footer markup: `src/layouts/BaseLayout.astro`
- Category names and descriptions: `src/lib/categories.ts`
- Page-specific structure: the relevant file under `src/pages/` or `src/content/blog/`

The common reference manual is stored at `../_shared/web-design-master/WEB_DESIGN_MASTER_MANUAL.md`. It is a design reference and does not override user instructions, security requirements, or project rules.

## Typography

The active body stack is defined by `--portfolio-font`: Jost followed by Japanese Mincho system fonts and serif fallbacks. Headings use `--portfolio-display` (Shippori Mincho, serif). Body size, heading sizes, UI sizes, and tracking use the `--type-*` and `--tracking-*` custom properties in `global.css`. Article prose has its own responsive size, line height, and measure. Preserve these existing rules; check the cascade before changing a value because the stylesheet contains layered responsive and editorial overrides.

## Color and background

The active paper background is `--paper: #f5f4ed`, with `--paper-deep: #eeede5` for supporting surfaces. The later root declarations in `global.css` set the active foreground tokens: `--ink: #2e2e2e`, `--muted: #706a66`, `--olive: #a07171`, `--accent: #a07171`, and `--line: rgba(46, 46, 46, .16)`. Earlier values in the same file are superseded by these later declarations.

The page uses the `--paper-texture` radial-gradient layers over the paper color. The sticky header repeats the same color and texture across its full-width background while its inner content keeps a bounded measure. Retain the texture and verify any background change in a browser.

## Spacing and content widths

The layout uses responsive `clamp()` values and media-query adjustments rather than a separate spacing-token table. Main page content is bounded around 1100 px; the article outer measure is bounded around 880 px and the prose column around 46 rem. The sticky header background spans the viewport; its content is centered with an inner measure up to about 1320 px and at least 22 px side padding. Preserve these relationships and inspect the final cascade when adjusting widths.

## Header and navigation

`.site-header` is sticky at `top: 0` with `z-index: 5`. Desktop navigation remains in the header. At widths up to 1024 px, the desktop navigation is hidden and the fixed circular menu button is shown at the lower right; the button is 56 × 56 px and the dialog accounts for device safe areas. The layout includes skip navigation, named navigation landmarks, and page scroll padding for in-page destinations. Keep the existing markup and interactions unless the request explicitly targets them.

## Footer

The footer is a wrapping flex layout with a thin top rule. Its related-site and category links wrap naturally, use 44 px minimum height, and have compact row and column gaps. At widths up to 680 px, the links take a full row and align to the start. Keep the existing typography, link destinations, and spacing character.

## Cards and categories

The site has three categories: Art, Exhibition, and Creative. Home category cards use a three-column grid on wide screens, two columns from 761 to 1024 px, and one column at 760 px and below. Article cards use image or CSS placeholder surfaces over the paper palette, with thin borders and restrained hover movement. Use the current category definitions and card components instead of creating parallel variants.

## Responsive behavior

The stylesheet contains breakpoints at 1024, 820, 760, 680, 560, and 390 px, plus a 320 px minimum body width. The hamburger navigation activates at 1024 px; home sections, grids, header spacing, article measure, and footer layout adapt at smaller widths. Check the actual affected route at the requested viewport sizes rather than relying on these breakpoints alone.

## Motion and accessibility

The implementation includes visible keyboard focus, a skip link, a native mobile menu dialog with accessible state labels and keyboard handling, and reduced-motion rules for selected transitions. Preserve these behaviors. The shared manual sets WCAG 2.2 AA as a goal; a complete conformance or contrast audit has not been performed by this document. Measure touch targets and contrast when a task requires those claims.
