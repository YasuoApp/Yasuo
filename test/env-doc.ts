import {
  isEnvFileName,
  parseEnv,
  printEnv,
  quoteValue,
} from "../src/renderer/lib/files/env-doc"
import { check, finish, section } from "./harness"

/**
 * A `.env` file as the rows the Env editor shows — `lib/files/env-doc.ts`.
 *
 * The check that matters most is the first: a file nobody edited prints back
 * byte for byte, since a value reprinted from its parsed form can be a value a
 * process reads differently.
 */

section("an untouched file prints back as it came")

const sample = [
  "# Database",
  "export DB_URL=postgres://localhost/db # local only",
  "",
  "SECRET='a b #c'",
  'MULTI="one',
  'two"',
  "URL=http://x/#frag",
  "not an assignment",
  'ESCAPED="a\\nb"',
  "",
].join("\n")

check("byte for byte", printEnv(parseEnv(sample)) === sample)

const crlf = "A=1\r\nB=2\r\n"
check("keeps CRLF", printEnv(parseEnv(crlf)) === crlf)
check("keeps a missing final newline", printEnv(parseEnv("A=1")) === "A=1")
check("an empty file is empty", printEnv(parseEnv("")) === "")

section("reading values")

const doc = parseEnv(sample)
const entries = doc.lines.flatMap((line) =>
  line.kind === "entry" ? [line] : []
)
const byKey = Object.fromEntries(entries.map((entry) => [entry.key, entry]))

check("export is noted", byKey.DB_URL?.exported === true)
check(
  "inline comment split off",
  byKey.DB_URL?.value === "postgres://localhost/db"
)
check("inline comment kept", byKey.DB_URL?.comment === "local only")
check("single quotes are literal", byKey.SECRET?.value === "a b #c")
check("a quoted value runs over lines", byKey.MULTI?.value === "one\ntwo")
check(
  "a # without a space is the value's",
  byKey.URL?.value === "http://x/#frag"
)
check("double quotes expand \\n", byKey.ESCAPED?.value === "a\nb")
check(
  "a non-assignment is kept as a line",
  doc.lines.some(
    (line) => line.kind === "other" && line.raw === "not an assignment"
  )
)
check(
  "an unclosed quote is kept verbatim",
  printEnv(parseEnv('A="open\nB=2\n')) === 'A="open\nB=2\n'
)

section("an edit reprints only its row")

const edited = parseEnv("# head\nA=1\nB='x'\n")
const b = edited.lines[2]!
if (b.kind === "entry") edited.lines[2] = { ...b, value: "it's", raw: null }
check(
  "other rows untouched, quoting changed where it must",
  printEnv(edited) === '# head\nA=1\nB="it\'s"\n',
  printEnv(edited)
)

section("quoting")

check("bare when it can be", quoteValue("abc", "none") === "abc")
check("quoted with a space", quoteValue("a b", "none") === '"a b"')
check("a newline is escaped", quoteValue("a\nb", "none") === '"a\\nb"')
check("keeps single quotes", quoteValue("a b", "single") === "'a b'")
check("an empty value is empty", quoteValue("", "none") === "")

section("which files")

check(".env", isEnvFileName(".env"))
check(".env.local", isEnvFileName(".env.local"))
check("not env.ts", !isEnvFileName("env.ts"))
check("not .envrc", !isEnvFileName(".envrc"))

finish()
