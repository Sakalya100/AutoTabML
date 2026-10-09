import type { Metadata } from "next";
import { Instrument_Sans, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import { AuthControls, AuthProvider } from "@/components/auth";
import { SmoothScroll } from "@/components/smooth-scroll";
import { GITHUB_URL, DOCS_URL } from "@/lib/links";
import "./globals.css";

const display = Instrument_Serif({ variable: "--font-display-serif", subsets: ["latin"], weight: "400", style: ["normal", "italic"] });
const body = Instrument_Sans({ variable: "--font-body", subsets: ["latin"] });
const code = JetBrains_Mono({ variable: "--font-code", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "AutoTinker — a tabular ML agent that knows when to stop", template: "%s · AutoTinker" },
  description:
    "AutoTinker evolves a readable ML pipeline for your table, keeps only statistically real gains, stops at the problem's ceiling, and reports how much it overfit.",
};

// The site is night throughout: no light theme. data-theme="dark" selects the dark tokens in globals.css.

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" data-theme="dark" style={{ colorScheme: "dark" }} className={`${display.variable} ${body.variable} ${code.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <AuthProvider>
          <SmoothScroll>
            <header className="border-b border-rule">
              <div className="flex items-center gap-6 px-4 py-3">
                <Link href="/" className="font-display text-[1.6rem] leading-none tracking-tight">
                  Auto<span className="italic text-best">Tinker</span>
                </Link>
                <nav className="ml-auto flex items-center gap-1 text-sm sm:gap-2">
                  <Link href="/replays" className="rounded px-2 py-1.5 text-ink-2 hover:text-ink">
                    Replays
                  </Link>
                  <a href={GITHUB_URL} className="hidden rounded px-2 py-1.5 text-ink-2 hover:text-ink sm:inline">
                    GitHub
                  </a>
                  <AuthControls />
                </nav>
              </div>
            </header>
            <div className="flex-1">{children}</div>
            <footer className="border-t border-rule">
              <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6 text-sm text-ink-3 sm:px-6">
                <span>AutoTinker v2 · MIT</span>
                <a href={GITHUB_URL} className="hover:text-ink">
                  Source
                </a>
                <a href={DOCS_URL} className="hover:text-ink">
                  Roadmap &amp; design notes
                </a>
                <Link href="/privacy" className="hover:text-ink">
                  Privacy
                </Link>
              </div>
            </footer>
          </SmoothScroll>
        </AuthProvider>
      </body>
    </html>
  );
}
