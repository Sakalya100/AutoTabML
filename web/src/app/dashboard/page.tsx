import type { Metadata } from "next";
import { DashboardPage } from "@/components/dashboard/dashboard";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Your runs, what they found, what they would cost and how far their estimates held up.",
  robots: { index: false },
};

export default function Page() {
  return <DashboardPage />;
}
