import { redirect } from "next/navigation";

/** The paste-a-link flow now lives in the session workspace. */
export default function NewRunPage() {
  redirect("/s/new");
}
