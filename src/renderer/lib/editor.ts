import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete"
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands"
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language"
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search"
import { Compartment, EditorState, type Extension } from "@codemirror/state"
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view"
import { tags as t } from "@lezer/highlight"

/**
 * CodeMirror, as the studio's one editing stack.
 *
 * Everything here is what any editor in the app needs — the font, the theme,
 * and the extensions a panel-sized editor is built with. What a particular
 * editor knows about a language lives with that panel: the Explorer's language
 * loading in `files/languages.ts`, the SQL console's schema completion in
 * `db/sql-completion.ts`, the request body's template grammar in
 * `http/body-language.ts`.
 *
 * Imported only from lazily-loaded chunks, the way Monaco was before it —
 * CodeMirror's core is a fraction of Monaco's four megabytes, but a language is
 * still a chunk each (`@codemirror/language-data` imports every one of them
 * dynamically), so an editor of any kind still costs a fetch the first time it
 * opens and a run that stays in the sidebars pays for none of it.
 *
 * There are no workers here, which is the one thing about this file worth
 * noticing next to what it replaced. Monaco put its tokenizer and its language
 * services on worker threads and needed five of them bundled and an
 * `app://`-origin `MonacoEnvironment` so a desktop app did not reach a CDN for
 * something already on disk. Lezer parses incrementally on the main thread in
 * time-sliced chunks, so none of that exists to be got wrong.
 */

/**
 * Compartments, which is how a CodeMirror view is reconfigured after it is
 * built.
 *
 * The Monaco equivalents were `setModelLanguage`, `updateOptions` and a global
 * `setTheme`; each of those is one of these, dispatched into the view that owns
 * it. **Sharing the compartment objects across views is deliberate and safe** —
 * a compartment is a key, and each view holds its own content under it — which
 * is what lets a panel reconfigure its own editor without reaching for a
 * per-instance object it would then have to keep.
 *
 * `themeConf` being per view is the improvement over what it replaced: Monaco
 * has one theme for every editor on the page, so every component that drew one
 * called `setTheme` globally and the last to notice a theme change won.
 */
export const languageConf = new Compartment()
export const themeConf = new Compartment()
export const optionsConf = new Compartment()

/** The studio's own mono stack, which is a CSS variable CodeMirror cannot read
 * from a `theme()` spec — it wants a font string, so it is resolved once here. */
export function monoFont(): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-mono")
    .trim()
  return value ? `${value}, ui-monospace, monospace` : "ui-monospace, monospace"
}

/*
 * The editor's own chrome, in the studio's tokens rather than in a palette of
 * its own.
 *
 * Everything structural — the gutter, the selection, the active line, the
 * find panel, the completion popover — is `var(--…)` off `styles/globals.css`,
 * so an editor follows the theme for the same reason every other surface in the
 * app does and there is no second set of colours to keep in step. Only the
 * *syntax* colours below are literal, because a token colour is not a UI colour:
 * there is no `--keyword` in a design system and inventing one would make every
 * language in the app the same three hues.
 */
function chromeTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        color: "var(--foreground)",
        // Transparent rather than `--background`: these panes sit on cards,
        // dialogs and split panels that each paint their own ground, and an
        // editor that repainted it would show as a rectangle a shade off.
        backgroundColor: "transparent",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": {
        fontFamily: monoFont(),
        fontSize: "13px",
        lineHeight: "1.6",
      },
      ".cm-content": { caretColor: "var(--foreground)" },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--foreground)",
        borderLeftWidth: "2px",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        {
          backgroundColor:
            "color-mix(in oklch, var(--primary) 28%, transparent)",
        },
      /*
       * The numbers are reference, not content, so they are dimmed — but by
       * **colour and not by `opacity`**, which is the distinction worth keeping.
       * `opacity` on `.cm-gutters` fades the whole column including any
       * background a gutter marker paints, and a child cannot undo an ancestor's
       * opacity. The diff pane tints its `+`/`-` cells that way (`GutterMarker`
       * `elementClass`, see `files/diff-chrome.ts`), so an `opacity: 0.65` here
       * came out as a row whose sign column was a visibly paler green than the
       * code beside it.
       */
      ".cm-gutters": {
        backgroundColor: "transparent",
        color: "color-mix(in oklch, var(--muted-foreground) 72%, transparent)",
        border: "none",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "transparent",
        color: "var(--foreground)",
      },
      ".cm-activeLine": {
        backgroundColor:
          "color-mix(in oklch, var(--foreground) 4%, transparent)",
      },
      ".cm-foldPlaceholder": {
        backgroundColor: "var(--muted)",
        color: "var(--muted-foreground)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        margin: "0 2px",
        padding: "0 4px",
      },
      ".cm-selectionMatch": {
        backgroundColor: "color-mix(in oklch, var(--primary) 16%, transparent)",
      },
      "&.cm-focused .cm-matchingBracket": {
        backgroundColor: "color-mix(in oklch, var(--primary) 22%, transparent)",
        outline: "none",
      },
      // The find panel, which CodeMirror draws as a real DOM bar rather than as
      // Monaco's floating widget. Styled as one of this app's own bars for that
      // reason: it is part of the pane, not something hovering over it.
      ".cm-panels": {
        backgroundColor: "var(--card)",
        color: "var(--foreground)",
        borderColor: "var(--border)",
      },
      ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
      ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
      ".cm-panel.cm-search": { padding: "6px 8px", fontFamily: "inherit" },
      ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label":
        { fontSize: "12px" },
      ".cm-panel.cm-search input[type=text]": {
        backgroundColor: "var(--input)",
        color: "var(--foreground)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        padding: "2px 6px",
      },
      ".cm-panel.cm-search button": {
        backgroundColor: "var(--secondary)",
        backgroundImage: "none",
        color: "var(--secondary-foreground)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        padding: "2px 8px",
      },
      ".cm-searchMatch": {
        backgroundColor: "color-mix(in oklch, var(--warning) 34%, transparent)",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "color-mix(in oklch, var(--warning) 60%, transparent)",
      },
      ".cm-tooltip": {
        backgroundColor: "var(--popover)",
        color: "var(--popover-foreground)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        boxShadow: "0 4px 16px rgb(0 0 0 / 0.14)",
        overflow: "hidden",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul": {
        fontFamily: monoFont(),
        fontSize: "12px",
        maxHeight: "16em",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "2px 6px" },
      ".cm-tooltip-autocomplete ul li[aria-selected]": {
        backgroundColor: "var(--accent)",
        color: "var(--accent-foreground)",
      },
      ".cm-completionIcon": { opacity: "0.6", paddingRight: "6px" },
      ".cm-completionDetail": {
        color: "var(--muted-foreground)",
        fontStyle: "normal",
        marginLeft: "8px",
      },
      ".cm-placeholder": { color: "var(--muted-foreground)", opacity: "0.7" },
    },
    // Tells CodeMirror's own built-in styles which way round they are, which is
    // what the light and dark defaults it ships are keyed on.
    { dark }
  )
}

/*
 * Syntax colours.
 *
 * These were VS Code's own Light+ and Dark+ token colours, which is what
 * Monaco's `vs` and `vs-dark` were, so that migrating the stack did not
 * silently restyle every file in the app. They are a hand-built pair now, for
 * the reason the migration itself removed: Dark+ is drawn for a flat `#1e1e1e`
 * ground with pure-hue tokens (`#0000ff` keywords, `#008000` comments), and the
 * studio's ground is a tinted near-black at a *chroma* of its own — a pure blue
 * keyword over it reads as a different material rather than as text.
 *
 * So each half is one ramp: a fixed lightness per theme, a chroma low enough
 * that a screen of code reads as prose rather than as a highlighter, and hues
 * spaced far enough apart to tell a string from a number at a glance. Nothing
 * here is the brand hue — a keyword that matched `--primary` would read as a
 * link. Comments are the one deliberate break with both ancestors: grey rather
 * than green, because a comment is the thing you skip and green is the loudest
 * colour on a dark ground.
 *
 * Written out literally rather than as `var(--…)` because a token colour is not
 * a UI colour: there is no `--keyword` in a design system and inventing one
 * would make every language in the app the same three hues.
 */
const lightHighlighting = HighlightStyle.define(
  [
    { tag: [t.comment, t.lineComment, t.blockComment], color: "#767a8a" },
    { tag: [t.keyword, t.modifier, t.controlKeyword], color: "#8a3fb8" },
    { tag: [t.operatorKeyword, t.definitionKeyword], color: "#8a3fb8" },
    { tag: [t.string, t.special(t.string)], color: "#2e7d43" },
    { tag: [t.regexp], color: "#0f7183" },
    { tag: [t.number, t.bool, t.null, t.atom], color: "#b0561a" },
    { tag: [t.typeName, t.className, t.namespace], color: "#0f7183" },
    { tag: [t.function(t.variableName), t.labelName], color: "#2f5fd0" },
    { tag: [t.propertyName], color: "#1a6a8c" },
    { tag: [t.variableName, t.attributeName], color: "#2b3245" },
    { tag: [t.tagName], color: "#b03a5b" },
    { tag: [t.meta, t.processingInstruction], color: "#b03a5b" },
    // Punctuation is structure rather than content and is dimmed to the
    // comment's own grey: it is on every line, so at full contrast it is the
    // densest colour on screen and none of it is worth reading.
    { tag: [t.operator, t.punctuation, t.bracket], color: "#767a8a" },
    { tag: [t.escape], color: "#b0561a" },
    { tag: [t.heading], color: "#2f5fd0", fontWeight: "bold" },
    { tag: [t.link, t.url], color: "#2f5fd0", textDecoration: "underline" },
    { tag: [t.emphasis], fontStyle: "italic" },
    { tag: [t.strong], fontWeight: "bold" },
    { tag: [t.strikethrough], textDecoration: "line-through" },
    { tag: [t.invalid], color: "#c33d3d" },
  ],
  { themeType: "light" }
)

const darkHighlighting = HighlightStyle.define(
  [
    { tag: [t.comment, t.lineComment, t.blockComment], color: "#6c7086" },
    { tag: [t.keyword, t.modifier, t.controlKeyword], color: "#c79bf0" },
    { tag: [t.operatorKeyword, t.definitionKeyword], color: "#c79bf0" },
    { tag: [t.string, t.special(t.string)], color: "#9ed7a8" },
    { tag: [t.regexp], color: "#7fcfdb" },
    { tag: [t.number, t.bool, t.null, t.atom], color: "#e8b17a" },
    { tag: [t.typeName, t.className, t.namespace], color: "#7fcfdb" },
    { tag: [t.function(t.variableName), t.labelName], color: "#8ba6f5" },
    { tag: [t.propertyName], color: "#a9d3ee" },
    { tag: [t.variableName, t.attributeName], color: "#d7d9e4" },
    { tag: [t.tagName], color: "#f2909f" },
    { tag: [t.meta, t.processingInstruction], color: "#f2909f" },
    { tag: [t.operator, t.punctuation, t.bracket], color: "#878b9e" },
    { tag: [t.escape], color: "#e8b17a" },
    { tag: [t.heading], color: "#8ba6f5", fontWeight: "bold" },
    { tag: [t.link, t.url], color: "#8ba6f5", textDecoration: "underline" },
    { tag: [t.emphasis], fontStyle: "italic" },
    { tag: [t.strong], fontWeight: "bold" },
    { tag: [t.strikethrough], textDecoration: "line-through" },
    { tag: [t.invalid], color: "#f78a8a" },
  ],
  { themeType: "dark" }
)

/**
 * What goes in `themeConf` — the chrome and the syntax colours for one of the
 * two themes.
 *
 * Both highlight styles are handed over together, with `themeType` deciding
 * which one applies: that is how CodeMirror is meant to carry a pair, and it
 * means a theme change is one dispatch rather than a rebuild.
 */
export function editorTheme(isDark: boolean): Extension {
  return [
    chromeTheme(isDark),
    syntaxHighlighting(isDark ? darkHighlighting : lightHighlighting),
    syntaxHighlighting(isDark ? lightHighlighting : darkHighlighting),
  ]
}

/**
 * The half of the editor every pane in the studio wants: editing that behaves
 * the way editing behaves, and nothing that costs width.
 *
 * This is what `basicSetup` would be if `basicSetup` were not also opinions
 * about a demo page. What is left out of it and why:
 *
 * - **No `lineNumbers`/`foldGutter` here** — every caller wants them, but the
 *   diff draws its own gutter, so they are the callers' to add.
 *   `panelChrome` and `fileChrome` below both do.
 * - **No `autocompletion`** unless a panel has something to complete. Monaco
 *   defaulted to word-based suggestions and every editor in the app turned them
 *   off; here the popover simply does not exist until something registers a
 *   source, which is the same decision made once instead of four times.
 * - **No `indentWithTab` by default.** Tab is how you leave a field, and three
 *   of these editors are fields inside forms.
 */
export function baseChrome(): Extension[] {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    highlightSpecialChars(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    rectangularSelection(),
    crosshairCursor(),
    EditorView.lineWrapping,
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
    ]),
  ]
}

/**
 * How an editor that is a *field* sits in the studio: a SQL statement, a
 * request body, a response.
 *
 * Deliberately not what the Explorer's file editor gets. That one is a place
 * you read and navigate a file; these are panes a few lines tall inside a form,
 * where a minimap and an active-line band are chrome competing with the text.
 * What they keep is the half that earns its space at any size — numbered lines,
 * folding, the find panel and wrapping.
 *
 * There is no `automaticLayout` to ask for, which is the other thing that got
 * simpler: Monaco measures its own box and needed a `ResizeObserver` switched on
 * to notice these panes being dragged or unhidden. A CodeMirror view lays out
 * in CSS, so a pane that changes size under it is a reflow rather than a
 * measurement it missed.
 */
export function panelChrome(): Extension[] {
  return [
    ...baseChrome(),
    lineNumbers(),
    foldGutter(),
    EditorView.theme({
      ".cm-content": { padding: "12px 0" },
      ".cm-scroller": { overflow: "auto" },
    }),
  ]
}

/**
 * How the Explorer's file editor sits: the same editing, plus the things that
 * only make sense against a real file — the active line, a tab that indents,
 * and a completion popover for the sources that register one.
 */
export function fileChrome(): Extension[] {
  return [
    ...baseChrome(),
    lineNumbers(),
    foldGutter(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    autocompletion(),
    keymap.of([indentWithTab]),
    EditorView.theme({
      ".cm-content": { padding: "8px 0" },
      ".cm-scroller": { overflow: "auto" },
    }),
  ]
}

/**
 * ⌘S, claimed from the page.
 *
 * `preventDefault` by returning true is the whole point: unclaimed, Chromium
 * reads the key as "save this page" and offers to write the studio to disk as
 * HTML. The panel claims it on the window too (`file-workspace.tsx`), for the
 * times focus is in the tree or the tab strip rather than in the editor.
 */
export function saveKeymap(onSave: () => void): Extension {
  return keymap.of([
    {
      key: "Mod-s",
      preventDefault: true,
      run: () => {
        onSave()
        return true
      },
    },
  ])
}

/** A view that takes no edit, for both sides of a diff.
 *
 * `editable` off **and** a `tabindex`, and both are load-bearing. Off, the
 * content is `contenteditable="false"` like the widgets inside it, and that is
 * what lets a selection begun on a removed row run on into the rows below:
 * Blink will not let a selection cross from non-editable content into
 * editable, so with the content editable a drag from a red line stopped dead
 * at the widget's edge (`lib/files/diff-selection.ts`). The `tabindex` is the
 * other half — `contenteditable="false"` cannot take focus on its own, so a
 * drag the editor runs had nowhere to put it and ⌘C went to the body, past
 * the editor's copy handler. `readOnly` is what the commands, paste, drop and
 * cut check. */
export function readOnly(): Extension[] {
  return [
    EditorView.editable.of(false),
    EditorState.readOnly.of(true),
    EditorView.contentAttributes.of({ tabindex: "0" }),
  ]
}
