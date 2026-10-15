import { useEffect } from "react"
import { UserRound } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useAccount, watchAccount } from "@/lib/account"
import { IconButton } from "./icon-button"

/**
 * Who is signed in, at the foot of the window's rail under Settings.
 *
 * An avatar rather than a row of text: the rail is 48px wide, and the thing to
 * know at a glance is only whether somebody is signed in. The name and the
 * actions are one click away in the menu it opens.
 */
export function AccountMenu() {
  const ready = useAccount((state) => state.ready)
  const account = useAccount((state) => state.account)
  const busy = useAccount((state) => state.busy)
  const error = useAccount((state) => state.error)
  const signIn = useAccount((state) => state.signIn)
  const cancelSignIn = useAccount((state) => state.cancelSignIn)
  const signOut = useAccount((state) => state.signOut)

  useEffect(watchAccount, [])

  const name = account ? (account.name ?? account.email ?? "Signed in") : null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <IconButton
            label={name ?? "Sign in with Google"}
            side="right"
            className="size-8"
          >
            {account?.photo ? (
              <img
                src={account.photo}
                alt=""
                referrerPolicy="no-referrer"
                className="size-6 rounded-full"
              />
            ) : account ? (
              <span className="flex size-6 items-center justify-center rounded-full bg-primary text-[0.65rem] font-medium text-primary-foreground">
                {initialOf(name ?? "")}
              </span>
            ) : (
              <UserRound />
            )}
          </IconButton>
        }
      />
      <DropdownMenuContent side="right" align="end" className="min-w-56">
        {/* A label is only valid inside a group — the menu throws without one. */}
        <DropdownMenuGroup>
          {account ? (
            <>
              <DropdownMenuLabel className="space-y-0.5">
                <span className="block text-sm font-medium">{name}</span>
                {account.email && account.email !== name && (
                  <span className="block text-xs font-normal text-muted-foreground">
                    {account.email}
                  </span>
                )}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={busy} onClick={() => void signOut()}>
                Sign out
              </DropdownMenuItem>
            </>
          ) : busy ? (
            <>
              <DropdownMenuLabel>
                Finish signing in in your browser…
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void cancelSignIn()}>
                Cancel
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem disabled={!ready} onClick={() => void signIn()}>
              Sign in with Google
            </DropdownMenuItem>
          )}

          {error && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs font-normal whitespace-normal text-destructive">
                {error}
              </DropdownMenuLabel>
            </>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The first letter of a name, for an avatar with no photo. */
function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?"
}
