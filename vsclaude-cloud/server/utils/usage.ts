/**
 * What a request cost, read off Anthropic's own answer, and the daily budget
 * it is held against.
 *
 * The budget is counted in **input-token equivalents** rather than raw tokens,
 * so one number covers a request that is mostly cache reads and one that is
 * mostly output: each kind is weighted by its price relative to an uncached
 * input token (Anthropic's ratios — cache writes 1.25×, cache reads 0.1×,
 * output 5×). A budget of 2,000,000 is then "what two million fresh input
 * tokens would cost", whatever the mix.
 */

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

export const NO_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

export function weighted(usage: Usage): number {
  return Math.ceil(
    usage.input_tokens +
      usage.cache_creation_input_tokens * 1.25 +
      usage.cache_read_input_tokens * 0.1 +
      usage.output_tokens * 5
  )
}

/** The `usage` object of a message or a delta, with anything missing as 0 —
 * a delta carries only the fields that moved. */
export function usageOf(raw: unknown, base: Usage = NO_USAGE): Usage {
  if (!raw || typeof raw !== "object") return base
  const fields = raw as Record<string, unknown>
  const pick = (key: keyof Usage) =>
    typeof fields[key] === "number" ? (fields[key] as number) : base[key]
  return {
    input_tokens: pick("input_tokens"),
    output_tokens: pick("output_tokens"),
    cache_creation_input_tokens: pick("cache_creation_input_tokens"),
    cache_read_input_tokens: pick("cache_read_input_tokens"),
  }
}

/**
 * Follows a streamed answer's usage without touching the stream.
 *
 * `message_start` carries the input side and an output count of a token or
 * two; each `message_delta` carries the **running** output total (not an
 * increment), and may restate the input side. So the last value seen of each
 * field is the answer.
 */
export class StreamUsage {
  usage: Usage = NO_USAGE
  private buffer = ""
  private readonly decoder = new TextDecoder()

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder
      .decode(chunk, { stream: true })
      .replace(/\r\n/g, "\n")
    let end: number
    // An SSE event ends at a blank line; a chunk can end mid-event.
    while ((end = this.buffer.indexOf("\n\n")) !== -1) {
      this.read(this.buffer.slice(0, end))
      this.buffer = this.buffer.slice(end + 2)
    }
  }

  private read(event: string): void {
    for (const line of event.split("\n")) {
      if (!line.startsWith("data:")) continue
      let data: unknown
      try {
        data = JSON.parse(line.slice(5).trim())
      } catch {
        continue
      }
      if (!data || typeof data !== "object") continue
      const frame = data as Record<string, unknown>
      if (frame.type === "message_start") {
        const message = frame.message as Record<string, unknown> | undefined
        this.usage = usageOf(message?.usage, this.usage)
      } else if (frame.type === "message_delta") {
        this.usage = usageOf(frame.usage, this.usage)
      }
    }
  }
}

/** The UTC day a request is counted under — the budget resets at 00:00 UTC. */
export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10)
}
