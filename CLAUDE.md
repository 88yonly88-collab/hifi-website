# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Corporate website for 株式会社Hi-Fi (HIGH FIDELITY INC.), a Japanese company offering AI-assisted business-efficiency tooling, workflow simplification, SNS marketing, video editing, and non-personality-dependent (非属人制) YouTube operations. The site content is in Japanese.

The repository is currently a **single-page static site** plus a detailed design document. There is no build system, package manager, framework, or test suite — `index.html` is self-contained and self-hosting.

## Structure

| Path | Contents |
|---|---|
| `index.html` | The entire top page. Self-contained: inline `<style>` (`:root` design tokens + all CSS) and one inline `<script>` at the end. The only external dependency is Google Fonts. |
| `docs/site-design-document.md` | Authoritative design spec — brand concept, target audience (SMB owners + financial institutions reviewing loan applications), IA/sitemap, design system, per-page wireframes, and implementation policy. **Read this before making design or content decisions.** |
| `README.md` | Short project summary and TODO list. |

## Running locally

No build step. Serve the directory or open the file directly:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

## Editing conventions

- **All styling flows through the CSS custom properties in `:root`** (top of the `<style>` block in `index.html`): color tokens (`--cream`, `--coral`, `--peach`, `--gold`, `--sage`, `--ink`…), shadows (`--shadow-sm/--shadow/--shadow-lg`), radius (`--r`), max width (`--maxw`), and font stacks (`--jp` Zen Kaku Gothic New, `--jpr` Zen Maru Gothic for warm/rounded headings, `--disp` Fraunces for display/italic accents). Change tokens rather than hard-coding values so the warm-friendly palette stays consistent.
- Sections are delimited by `<!-- ===== NAME ===== -->` comment banners (HEADER, HERO, STATS, STRENGTHS, SERVICES, AI BAND, WORKS, FLOW, COMPANY, FINAL CTA, FOOTER). Preserve this pattern when adding sections.
- The trailing `<script>` handles three things only, with no dependencies: sticky-header shadow on scroll, `IntersectionObserver` reveal-on-scroll for `.reveal` elements, and count-up animation for `.num[data-to]` elements (uses `data-to` / `data-suffix`). Reuse these hooks (add `.reveal` / `.num` classes) rather than adding new libraries.
- Keep the site framework-free and self-contained unless a task explicitly calls for introducing a stack.

## Design intent (from the design document)

These constraints exist because two distinct audiences must trust the site — SMB owners and financial institutions reviewing the company for financing:

- **Tone**: warm & friendly (customer-empathetic) crossed with trust × advanced-tech. Cream base + coral + peach + gold.
- **Trust signals** are deliberate: company facts (founded 2017 / 平成29年, 資本金 100万円, 代表 波江野 亮介, 横浜 address) belong in the footer and company section as plain facts — do **not** over-hype continuity in the hero (the company had a dormant period). Fix the official address string exactly to avoid 表記揺れ. Prefer 西暦+和暦 together for dates.
- **Restraint**: generous whitespace, subtle rounded corners, light shadows, line-style icons, and motion limited to gentle fade/slide. Over-animation reads as untrustworthy.
- **Accessibility**: contrast AA+, scalable text, alt text — treated as a scoring factor for public-institution readers.
- Meaningful, typo-free copy matters as much as code here: careful detail is read as careful management.

## Open TODOs (see README)

Contact details (TEL/email) are still unconfirmed; emoji icons are placeholders to be replaced with line-art SVGs; sub-pages (service detail, company, AI, works, contact form) and legal pages are not yet built. The design document's section 5 contains wireframes for these future pages.
