import { SignUp } from "@clerk/nextjs";
import { notFound } from "next/navigation";
import { AUTH_ENABLED } from "@/lib/auth-flag";

export default function SignUpPage() {
  if (!AUTH_ENABLED) notFound();
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <SignUp />
    </div>
  );
}
