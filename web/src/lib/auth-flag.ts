/** Sign-in is on when the build has a Clerk publishable key; without one the site stays anonymous (browser cookie). */
export const AUTH_ENABLED = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
