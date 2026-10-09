import { SignUp } from "@clerk/nextjs";
import { notFound } from "next/navigation";
import { AuthStage, authCardAppearance } from "@/app/sign-in/auth-stage";
import { AFTER_SIGN_IN, AUTH_ENABLED } from "@/lib/auth-flag";

export default function SignUpPage() {
  if (!AUTH_ENABLED) notFound();
  return (
    <AuthStage
      line={
        <>
          Bring a table. Keep only what&apos;s <em>real.</em>
        </>
      }
    >
      <SignUp appearance={authCardAppearance} forceRedirectUrl={AFTER_SIGN_IN} signInForceRedirectUrl={AFTER_SIGN_IN} />
    </AuthStage>
  );
}
