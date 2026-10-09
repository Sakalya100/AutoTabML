import { SignIn } from "@clerk/nextjs";
import { notFound } from "next/navigation";
import { AUTH_ENABLED } from "@/lib/auth-flag";
import { AuthStage, authCardAppearance } from "../auth-stage";

export default function SignInPage() {
  if (!AUTH_ENABLED) notFound();
  return (
    <AuthStage
      line={
        <>
          Your models, kept <em>honest.</em>
        </>
      }
    >
      <SignIn appearance={authCardAppearance} />
    </AuthStage>
  );
}
