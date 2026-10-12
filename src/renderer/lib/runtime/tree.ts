/** Splits `"src/lib/db.ts"` into `["src/lib", "db.ts"]`. */
export function splitPath(path: string): [dir: string, name: string] {
  const index = path.lastIndexOf("/")
  return index === -1
    ? ["", path]
    : [path.slice(0, index), path.slice(index + 1)]
}

export function dirname(path: string): string {
  return splitPath(path)[0]
}

export function basename(path: string): string {
  return splitPath(path)[1]
}

export function extname(path: string): string {
  const name = basename(path)
  const index = name.lastIndexOf(".")
  return index <= 0 ? "" : name.slice(index + 1).toLowerCase()
}
