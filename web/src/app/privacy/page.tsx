import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Privacy policy",
  description: "What AutoTinker collects, why, who processes it, and how to have it deleted.",
};

const UPDATED = "8 October 2026";
const CONTACT = "sakalyamitra@gmail.com";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="font-display text-[1.6rem] leading-tight text-ink">{title}</h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-ink-2">{children}</div>
    </section>
  );
}

function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-2">
      {items.map((x, i) => (
        <li key={i} className="grid grid-cols-[1rem_minmax(0,1fr)]">
          <span aria-hidden className="text-ink-3">
            –
          </span>
          <span>{x}</span>
        </li>
      ))}
    </ul>
  );
}

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-[44rem] px-4 py-14 sm:px-6">
      <p className="font-mono text-[11.5px] tracking-[0.2em] text-ink-3 uppercase">Privacy policy</p>
      <h1 className="mt-4 font-display text-[clamp(2.2rem,5vw,3.2rem)] leading-[1.05] text-ink">What AutoTinker keeps, and why.</h1>
      <p className="mt-4 text-[15px] leading-relaxed text-ink-2">
        AutoTinker (autotinker.sakalya.si) is a personal, non-commercial project by Sakalya Mitra: a team of AI agents that builds and tests machine-learning
        models on a table you give it. This page explains what data that involves. Last updated {UPDATED}.
      </p>

      <Section title="What we collect">
        <List
          items={[
            <>
              <strong className="text-ink">Your account.</strong> When you sign in with Google or an email code, our sign-in provider (Clerk) stores your email
              address and, for Google, your name and profile picture. We never see or store a password: there isn’t one.
            </>,
            <>
              <strong className="text-ink">Your runs.</strong> For each session we store what you typed in the chat, the run settings (column to predict, metric,
              number of experiments), the link to your dataset or the uploaded file’s name and size, and everything the run produced: the agents’ plans and
              reasoning, the code they wrote, scores, logs and the final report. These can include column names, summary statistics and a few example values from
              your data.
            </>,
            <>
              <strong className="text-ink">Your dataset.</strong> A linked CSV is downloaded, and an uploaded CSV is passed, into an isolated sandbox that exists
              only for that run and is destroyed when it ends. We don’t keep a copy of the file itself.
            </>,
            <>
              <strong className="text-ink">Technical data.</strong> Your IP address is used for rate limiting (kept for at most an hour) and appears in our
              hosting provider’s request logs.
            </>,
          ]}
        />
      </Section>

      <Section title="How it is used">
        <p>
          Only to run the service: to sign you in, run your experiments, show you your sessions, and stop abuse. We don’t sell your data, show ads, or use it
          for any other purpose. There is no analytics or tracking beyond what is listed here.
        </p>
      </Section>

      <Section title="Who processes it">
        <List
          items={[
            <>
              <strong className="text-ink">Clerk</strong>: sign-in and accounts.
            </>,
            <>
              <strong className="text-ink">Google</strong>: “Continue with Google” sign-in, if you use it (we receive your name, email and picture).
            </>,
            <>
              <strong className="text-ink">Vercel</strong>: hosting, and the sandboxes your experiments run in.
            </>,
            <>
              <strong className="text-ink">Neon</strong>: the database holding your sessions and runs.
            </>,
            <>
              <strong className="text-ink">Groq</strong>: runs the AI models. Agents that read your data (to understand the table) send it a sample of rows.
            </>,
            <>
              <strong className="text-ink">Google Gemini</strong>: a fallback AI model, used for writing code, judging and reporting. It never receives rows from
              your data, only column names, statistics, code and results. It is used on Google’s free tier, under which Google may use prompts to improve its
              products.
            </>,
          ]}
        />
        <p>
          Don’t use AutoTinker with personal, confidential or regulated data (health records, financial details, anything about identifiable people). It is a
          research demo, not a place for sensitive data.
        </p>
      </Section>

      <Section title="Cookies and local storage">
        <p>
          Clerk sets cookies to keep you signed in. If you used AutoTinker before signing in, a signed cookie identified your browser’s sessions; it is removed
          once those sessions move to your account. Your light / dark theme choice is kept in your browser’s local storage. No advertising or tracking cookies.
        </p>
      </Section>

      <Section title="How long we keep it">
        <p>
          Sessions and runs are kept until you ask us to delete them or the project shuts down. Uploaded files are not kept. Rate-limit records last at most an
          hour; hosting logs follow Vercel’s retention.
        </p>
      </Section>

      <Section title="Your choices">
        <p>
          You can ask for a copy of your data, or for your account and all your sessions and runs to be deleted, by emailing{" "}
          <a href={`mailto:${CONTACT}`} className="text-ink underline decoration-rule-strong underline-offset-4 hover:decoration-best">
            {CONTACT}
          </a>{" "}
          from the address you sign in with. We’ll do it within 30 days. You can stop using AutoTinker at any time; replays can be watched without an account.
        </p>
      </Section>

      <Section title="Children">
        <p>AutoTinker is not meant for anyone under 13, and we don’t knowingly collect their data.</p>
      </Section>

      <Section title="Changes">
        <p>If this policy changes, this page and its date change with it. Material changes will be noted here before they take effect.</p>
      </Section>

      <p className="mt-12 text-[14px] text-ink-3">
        Questions:{" "}
        <a href={`mailto:${CONTACT}`} className="underline underline-offset-4 hover:text-ink">
          {CONTACT}
        </a>{" "}
        ·{" "}
        <Link href="/" className="underline underline-offset-4 hover:text-ink">
          Back to AutoTinker
        </Link>
      </p>
    </main>
  );
}
