# File-type icons

From [vscode-icons](https://github.com/vscode-icons/vscode-icons) —
Copyright (c) 2016 Roberto Huertas, MIT licensed. Vendored unmodified, keeping
their `file_type_*.svg` names so each one can be traced back to its original.

**A subset, not the set.** vscode-icons ships around fifteen hundred of these;
what is here is the fifty-odd a workspace in this studio actually contains. All
of them would be several megabytes in git — the same trade this repository
already refused for Excalidraw's fonts (see the `excalidraw-fonts` plugin in
`vite.config.ts`) — for a tree that would go on showing the same handful of
types.

Adding one is two steps and no more: drop the `file_type_<name>.svg` in here,
and add the extension or filename to a table in
`src/renderer/lib/files/icon-names.ts`. `icons.ts` collects this directory with
`import.meta.glob`, so nothing else needs to learn about it. A type with no icon
falls back to the studio's own Lucide glyph rather than to a wrong one.

Two were changed on the way in, both for size: `file_type_pdf.svg` is the
upstream `file_type_pdf2.svg`, a tenth the weight of the illustrated one, and
`license` was left out entirely at 24 kB for a scroll nobody was going to
recognise at 14 pixels.
