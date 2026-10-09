import type { Metadata } from "next";
import { Instrument_Sans, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import { AuthProvider } from "@/components/auth";
import { Atmosphere } from "@/components/chrome/atmosphere";
import { SiteFooter } from "@/components/chrome/site-footer";
import { SiteHeader } from "@/components/chrome/site-header";
import { SmoothScroll } from "@/components/smooth-scroll";
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
            <SiteHeader />
            <div className="flex-1">{children}</div>
            <SiteFooter />
            <Atmosphere />
          </SmoothScroll>
        </AuthProvider>
      </body>
    </html>
  );
}
