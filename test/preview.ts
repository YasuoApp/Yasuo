import { devServerUrlIn, scanDevServer } from "../src/renderer/lib/preview"
import { check, finish, section } from "./harness"

/**
 * What a dev server's banner says the page is at, read off the shell's
 * output. The banners are painted — colours, a hyperlink — and arrive in
 * whatever pieces the pty cut them into, so the test is about the reading
 * rather than the regex.
 */

section("devServerUrlIn")
{
  check(
    "vite's banner, in colour",
    devServerUrlIn(
      "\x1b[32m  ➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\r\n"
    ) === "http://localhost:5173/"
  )
  check(
    "next's banner",
    devServerUrlIn("   - Local:        http://localhost:3000\n") ===
      "http://localhost:3000"
  )
  check(
    "a loopback address",
    devServerUrlIn("* Running on http://127.0.0.1:5000") ===
      "http://127.0.0.1:5000"
  )
  check(
    "the bind address is reached as localhost",
    devServerUrlIn("Listening on http://0.0.0.0:8080/") ===
      "http://localhost:8080/"
  )
  check(
    "a hyperlinked URL",
    devServerUrlIn(
      "\x1b]8;;http://localhost:4321\x1b\\http://localhost:4321\x1b]8;;\x1b\\"
    ) === "http://localhost:4321"
  )
  check(
    "the sentence's punctuation is not the URL's",
    devServerUrlIn("open (http://localhost:3000).") === "http://localhost:3000"
  )
  check(
    "a path is kept",
    devServerUrlIn("http://localhost:3000/app?x=1 ready") ===
      "http://localhost:3000/app?x=1"
  )
  check(
    "the first of two",
    devServerUrlIn(
      "Local: http://localhost:5173/\nNetwork: http://192.168.1.4:5173/\n"
    ) === "http://localhost:5173/"
  )
  check(
    "a network address alone is not the preview's",
    devServerUrlIn("Network: http://192.168.1.4:5173/") === null
  )
  check("a remote host is not", devServerUrlIn("https://example.com") === null)
  check("a bare port is not", devServerUrlIn("port 5173") === null)
  check("nothing", devServerUrlIn("") === null)
}

section("scanDevServer")
{
  const first = scanDevServer("", "  Local:   http://local")
  check("a split URL waits", first.url === null, first)
  const second = scanDevServer(first.carry, "host:5173/\r\n")
  check(
    "and is joined by the next chunk",
    second.url === "http://localhost:5173/",
    second
  )
  const third = scanDevServer(second.carry, "  ready in 300ms\r\n")
  check("a URL already found is not found again", third.url === null, third)

  const long = scanDevServer("", "x".repeat(2000))
  check("the carry is bounded", long.carry.length <= 256, long.carry.length)

  const again = scanDevServer(
    scanDevServer("", "http://localhost:3000\n").carry,
    "now on http://localhost:3001\n"
  )
  check("a later URL is the later one", again.url === "http://localhost:3001")
}

finish()
