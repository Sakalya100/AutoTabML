import { SignIn } from "@clerk/nextjs";
import { notFound } from "next/navigation";
import { AUTH_ENABLED } from "@/lib/auth-flag";

export default function SignInPage() {
  if (!AUTH_ENABLED) notFound();
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <SignIn />
    </div>
  );
}
