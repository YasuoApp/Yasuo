/**
 * A run of the transcript, selected, as the composer should receive it.
 *
 * **A quote, not a fence.** What the dock's shell delivers is output and goes
 * in a fence (`fencedOutput`), so the model reads it as something a program
 * printed. What is selected in a conversation is something somebody *said*,
 * and the mark for that in Markdown is `>` — which the CLI renders as a quote
 * too, so the reply reads as one on both ends. Every line is prefixed,
 * including a blank one inside the run, so a two-paragraph quote is one quote
 * rather than a quote, a paragraph, and a second quote.
 *
 * Two blank lines after, which is what makes the caret land *under* the quote
 * ready for the question, rather than on the end of its last line where typing
 * would extend it.
 */
export function quoteOf(text: string): string {
  const body = text.replace(/\s+$/, "").replace(/^\n+/, "")
  if (!body) return ""
  return `${body
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n")}\n\n`
}
