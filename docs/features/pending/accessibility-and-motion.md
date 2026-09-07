# Accessibility & Motion

> Implemented in v0.1.0 (`8859f29d`): reduced motion; overlay motion/blur expanded in v0.21.7 (`4d9f19a4`). See [appearance and motion](../../../README.md#14-見た目と設定).
> ARIA and keyboard coverage are partial; AAA high contrast and full localization remain pending.

## ARIA Roles & Screen Reader Support

Proper semantic markup for assistive technology navigation.

| Detail | Description |
|--------|-------------|
| cmux | macOS accessibility APIs for VoiceOver, role annotations on all interactive elements |
| Partial | Dialog roles, ARIA labels and focus management exist; complete pane/tab/screen-reader coverage still needs auditing |
| Components | `TabBar`, `PaneTabBar`, `TerminalPane`, `CrsmPalette` need consistent ARIA coverage |
| Priority | **Medium** |

## High Contrast Mode

Accessibility theme with increased contrast ratios meeting WCAG AAA.

| Detail | Description |
|--------|-------------|
| cmux | High contrast color scheme option in settings |
| Needs | New theme in `themeDefinitions.ts` with AAA contrast ratios |
| Needs | `prefers-contrast: more` media query detection |
| Priority | **Medium** |

## Reduced Motion — Implemented

Respect `prefers-reduced-motion` for users sensitive to animations.

| Detail | Description |
|--------|-------------|
| cmux | Disables all transitions and animations when system preference set |
| Shipped | CSS `@media (prefers-reduced-motion: reduce)` blocks in `global.css` and component styles |
| Shipped | Global animation/transition durations reduce to 0.01ms, one iteration; component rules disable selected animations |
| Current | Global reduced-motion rule in `src/global.css`; deferred overlay exit also respects the preference |
| Priority | **High** |

### Implementation

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

## Internationalization (i18n)

Multi-language support for UI strings.

| Detail | Description |
|--------|-------------|
| cmux | English only, but structured for localization with string constants |
| Needs | `i18next` or similar, string extraction from components |
| Needs | Language selector in settings, RTL layout support |
| Scope | UI strings across tabs, settings, buttons, menus and tooltips; no complete localization layer |
| Priority | **Low** |

## Keyboard Navigation

Full keyboard accessibility for all UI elements without mouse.

| Detail | Description |
|--------|-------------|
| cmux | Tab-order management, focus rings, keyboard-only navigation mode |
| Needs | `tabIndex` management, visible focus indicators, skip-to-content |
| Needs | Arrow key navigation in `TabBar` and `PaneTabBar` |
| Priority | **Medium** |
