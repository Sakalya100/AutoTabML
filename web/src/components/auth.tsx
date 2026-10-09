"use client";

/**
 * Sign-in (Clerk: email code + Google). Optional by build: with no NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY the site runs
 * as before (anonymous sessions tied to a browser cookie) and none of this renders. The FastAPI backend checks the
 * same Clerk session cookie (`__session`), so the browser never handles a token itself.
 */
import { ClerkProvider, Show, SignInButton, UserButton, useAuth, useClerk } from "@clerk/nextjs";
import Link from "next/link";
import { useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useMagnetic } from "@/components/chrome/magnetic";
import { AFTER_SIGN_IN, AUTH_ENABLED } from "@/lib/auth-flag";

export { AUTH_ENABLED };

/** Clerk's components in the site's tokens, so they follow the light / dark theme. */
const appearance = {
  variables: {
    colorPrimary: "var(--best)",
    colorPrimaryForeground: "#05070a",
    colorBackground: "var(--paper-2)",
    colorInput: "var(--paper)",
    colorForeground: "var(--ink)",
    colorMutedForeground: "var(--ink-3)",
    colorNeutral: "var(--ink)",
    colorBorder: "var(--rule-strong)",
    colorDanger: "var(--crash)",
    fontFamily: "var(--font-body)",
    borderRadius: "0.6rem",
  },
};

/** The account menu, drawn in the header's hairline language (classes styled in globals.css). */
const userButtonAppearance = {
  elements: {
    userButtonTrigger: "site-avatar-trigger",
    avatarBox: "site-avatar",
    userButtonPopoverCard: "site-account-card",
  },
};

export function AuthProvider({ children }: { children: ReactNode }) {
  if (!AUTH_ENABLED) return <>{children}</>;
  return (
    <ClerkProvider
      appearance={appearance}
      signInForceRedirectUrl={AFTER_SIGN_IN}
      signUpForceRedirectUrl={AFTER_SIGN_IN}
      signInFallbackRedirectUrl={AFTER_SIGN_IN}
      signUpFallbackRedirectUrl={AFTER_SIGN_IN}
    >
      {children}
    </ClerkProvider>
  );
}

/** Header controls: "Sign in" when signed out, the account menu when signed in. */
export function AuthControls() {
  if (!AUTH_ENABLED) return null;
  return (
    <>
      <Show when="signed-out">
        <SignInButton mode="modal" forceRedirectUrl={AFTER_SIGN_IN} signUpForceRedirectUrl={AFTER_SIGN_IN}>
          <SignInPill />
        </SignInButton>
      </Show>
      <Show when="signed-in">
        <span className="site-account">
          <UserButton appearance={userButtonAppearance} />
        </span>
      </Show>
    </>
  );
}

/** The header's "Sign in": a hairline pill that leans toward the cursor. Clerk's SignInButton passes onClick in. */
function SignInPill(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const ref = useRef<HTMLButtonElement>(null);
  useMagnetic(ref, 0.22);
  return (
    <button ref={ref} type="button" className="site-signin" {...props}>
      <span className="site-signin-label">Sign in</span>
    </button>
  );
}

export interface SignedInState {
  /** Clerk is configured on this build. */
  enabled: boolean;
  /** Clerk has finished loading (always true when auth is off). */
  loaded: boolean;
  /** May use the workspace: signed in, or auth is off. */
  signedIn: boolean;
  /** Changes when the account changes, to refetch per-user data. */
  userId: string | null;
}

function useClerkState(): SignedInState {
  const { isLoaded, isSignedIn, userId } = useAuth();
  return { enabled: true, loaded: isLoaded, signedIn: !!isSignedIn, userId: userId ?? null };
}
const anonymous: SignedInState = { enabled: false, loaded: true, signedIn: true, userId: null };
const useAnonymousState = (): SignedInState => anonymous;

/** Chosen once per build, so hooks run in the same order on every render. */
export const useSignedIn: () => SignedInState = AUTH_ENABLED ? useClerkState : useAnonymousState;

/** Opens the sign-in modal; signing in (or up) lands on the dashboard. null when auth is off. */
type OpenSignIn = (() => void) | null;
function useClerkOpenSignIn(): OpenSignIn {
  const clerk = useClerk();
  return () => clerk.openSignIn({ forceRedirectUrl: AFTER_SIGN_IN, signUpForceRedirectUrl: AFTER_SIGN_IN });
}
const useNoSignIn = (): OpenSignIn => null;
export const useOpenSignIn: () => OpenSignIn = AUTH_ENABLED ? useClerkOpenSignIn : useNoSignIn;

/** The workspace's call to sign in: in the chat pane when signed out. */
export function SignInPrompt({ title = "Sign in to start a run." }: { title?: string }) {
  return (
    <div className="ws-empty">
      <p className="ws-kicker">Sign in</p>
      <h1 className="mt-4 font-display text-[clamp(2.2rem,4.4vw,3.4rem)] leading-[1.02] tracking-[-0.01em]">{title}</h1>
      <p className="mt-4 max-w-[46ch] text-[15px] leading-relaxed text-[var(--lp-ink-2)]">
        Your sessions and runs are saved to your account. Use Google, or get a one-time code by email: no password.
      </p>
      <div className="mt-7 flex flex-wrap items-center gap-4">
        <SignInButton mode="modal" forceRedirectUrl={AFTER_SIGN_IN} signUpForceRedirectUrl={AFTER_SIGN_IN}>
          <button type="button" className="ws-start">
            Sign in <span aria-hidden>→</span>
          </button>
        </SignInButton>
        <Link href="/replays" className="ws-link text-[14px]">
          Or watch a replay
        </Link>
      </div>
    </div>
  );
}
