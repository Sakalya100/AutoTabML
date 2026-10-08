import type { Metadata } from "next";
import { WorkspaceShell } from "@/components/workspace/shell";
import "@/components/terra.css";
import "@/components/new-run.css";
import "@/components/workspace/workspace.css";

export const metadata: Metadata = { title: "Sessions" };

/** The workspace: sessions | chat | live map. The sessions list lives here so it persists across session pages. */
export default function WorkspaceLayout({ children }: LayoutProps<"/s">) {
  return <WorkspaceShell>{children}</WorkspaceShell>;
}
