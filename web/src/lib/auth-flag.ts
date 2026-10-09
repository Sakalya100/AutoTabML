/** Sign-in is on when the build has a Clerk publishable key; without one the site stays anonymous (browser cookie). */
export const AUTH_ENABLED = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

/** Where every sign-in and sign-up lands, whichever button, page or provider (Google's round trip too) started it. */
export const AFTER_SIGN_IN = "/dashboard";
