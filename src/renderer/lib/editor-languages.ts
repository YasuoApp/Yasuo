import { LanguageDescription } from "@codemirror/language"
import { languages as registry } from "@codemirror/language-data"
import type { Extension } from "@codemirror/state"

import { nameOf } from "./files/paths"

/**
 * Which language a thing is in, asked of CodeMirror's own registry rather than
 * of a table kept here.
 *
 * `@codemirror/language-data` is 143 `LanguageDescription`s — a name, its
 * aliases, its extensions, and a `load()` that dynamically imports the parser.
 * A second list in this repository could only ever be a worse copy that also
 * has to be kept in step with it, which is the argument the Monaco version of
 * this file made about `monaco.languages.getLanguages()` and is the reason it
 * ports over unchanged.
 *
 * **What is different is that a language is now loaded rather than registered.**
 * Monaco shipped every grammar it had in the chunk and picking one was a string;
 * here each parser is its own dynamic import, so resolving a language is
 * synchronous and *using* one is a promise. Every caller therefore starts with
 * no highlighting and gets it a frame or two later, which for a language already
 * fetched in this run is a resolved promise and for the first `.rs` in a session
 * is one small chunk off local disk. That is the trade that stopped this app
 * carrying four megabytes of grammars for a session that opens one JSON file.
 */

/**
 * The registry, and the two languages it lacks. A `.env` matches nothing there
 * — it is a dotfile with no extension, and in `.env.local` the extension is the
 * environment's name — so it is matched by name; a Makefile is a name too. Both
 * go ahead of the registry so nothing in it can claim the file first.
 */
const languages: readonly LanguageDescription[] = [
  LanguageDescription.of({
    name: "dotenv",
    alias: ["env"],
    filename: /^\.env(\..+)?$/i,
    load: () => import("./editor-dotenv").then((module) => module.dotenv()),
  }),
  LanguageDescription.of({
    name: "Makefile",
    alias: ["make", "mk"],
    extensions: ["mk", "mak"],
    filename: /^(?:GNUmakefile|makefile)$/i,
    load: () => import("./editor-makefile").then((module) => module.makefile()),
  }),
  ...registry,
]

/**
 * The description for a file, by name then by extension.
 *
 * `matchFilename` does both, in that order, and it is the order that matters:
 * `Dockerfile` and `CMakeLists.txt` are whole names in the registry rather than
 * extensions, and a file called `foo.Dockerfile` should still be one.
 */
export function languageForFile(filePath: string): LanguageDescription | null {
  return LanguageDescription.matchFilename(languages, nameOf(filePath))
}

/**
 * The description for a name or an alias — `json`, `pgsql`, `typescript`.
 *
 * Case-insensitive and alias-aware in the registry itself, so the ids this app
 * already passed around (see `lib/language.ts`, whose strings were Monaco's own
 * language ids) resolve without a translation table. A name nobody knows is
 * `null`, which is the studio's way of saying no highlighting rather than a
 * wrong guess.
 */
export function languageNamed(name: string): LanguageDescription | null {
  return LanguageDescription.matchLanguageName(languages, name, true)
}

/**
 * A language as an extension, ready to go into `languageConf`.
 *
 * `[]` for a language nobody recognises, which is the honest answer and also
 * exactly what an editor showing plain text wants in that compartment.
 * `LanguageDescription.load` memoises its own import, so the second `.ts` file
 * of a run does not fetch the parser again.
 */
export async function languageExtension(
  description: LanguageDescription | null
): Promise<Extension> {
  if (!description) return []
  try {
    return await description.load()
  } catch {
    // A chunk that would not load is a file without highlighting, which is what
    // an unknown extension already gets. Not worth a notice over.
    return []
  }
}
