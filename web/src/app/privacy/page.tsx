import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { RevealHeading } from "@/components/replay/motion";
import { PrivacyIndex } from "./privacy-index";
import "@/components/terra.css";
import "./privacy.css";

export const metadata: Metadata = {
  title: "Privacy policy",
  description: "What AutoTinker collects, why, who processes it, and how to have it deleted.",
};

const UPDATED = "8 October 2026";
const CONTACT = "sakalyamitra@gmail.com";

const SECTIONS = [
  { id: "collect", title: "What we collect" },
  { id: "use", title: "How it is used" },
  { id: "processors", title: "Who processes it" },
  { id: "cookies", title: "Cookies and local storage" },
  { id: "retention", title: "How long we keep it" },
  { id: "choices", title: "Your choices" },
  { id: "children", title: "Children" },
  { id: "changes", title: "Changes" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  const n = SECTIONS.findIndex((x) => x.id === id);
  return (
    <section id={id} className="pv-sec" data-pv-sec>
      <p className="pv-num" aria-hidden>
        § {String(n + 1).padStart(2, "0")}
      </p>
      <RevealHeading className="pv-h2" on="view">
        {SECTIONS[n].title}
      </RevealHeading>
      <div className="pv-text">{children}</div>
    </section>
  );
}

function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="pv-list">
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  );
}

export default function PrivacyPage() {
  return (
    <main data-terra className="pv-root">
      <header className="pv-head">
        <p className="pv-kicker">Privacy policy</p>
        <RevealHeading as="h1" className="pv-h1" pre delay={0.1}>
          What AutoTinker keeps, <em>and why.</em>
        </RevealHeading>
        <p className="pv-lede">
          AutoTinker (autotinker.sakalya.si) is a personal, non-commercial project by Sakalya Mitra: a team of AI agents that builds and tests machine-learning
          models on a table you give it. This page explains what data that involves.
        </p>
        <dl className="pv-meta">
          <div>
            <dt>Last updated</dt>
            <dd>{UPDATED}</dd>
          </div>
          <div>
            <dt>Reading time</dt>
            <dd>About four minutes</dd>
          </div>
          <div>
            <dt>Contact</dt>
            <dd>
              <a href={`mailto:${CONTACT}`}>{CONTACT}</a>
            </dd>
          </div>
        </dl>
      </header>

      <div className="pv-grid">
        <PrivacyIndex items={SECTIONS.map((x) => ({ id: x.id, title: x.title }))} />
        <article className="pv-body">
          <Section id="collect">
            <List
              items={[
                <>
                  <strong>Your account.</strong> When you sign in with Google or an email code, our sign-in provider (Clerk) stores your email address and, for
                  Google, your name and profile picture. We never see or store a password: there isn’t one.
                </>,
                <>
                  <strong>Your runs.</strong> For each session we store what you typed in the chat, the run settings (column to predict, metric, number of
                  experiments), the link to your dataset or the uploaded file’s name and size, and everything the run produced: the agents’ plans and reasoning,
                  the code they wrote, scores, logs and the final report. These can include column names, summary statistics and a few example values from your
                  data.
                </>,
                <>
                  <strong>Your dataset.</strong> A linked CSV is downloaded, and an uploaded CSV is passed, into an isolated sandbox that exists only for that
                  run and is destroyed when it ends. We don’t keep a copy of the file itself.
                </>,
                <>
                  <strong>Technical data.</strong> Your IP address is used for rate limiting (kept for at most an hour) and appears in our hosting provider’s
                  request logs.
                </>,
              ]}
            />
          </Section>

          <Section id="use">
            <p>
              Only to run the service: to sign you in, run your experiments, show you your sessions, and stop abuse. We don’t sell your data, show ads, or use
              it for any other purpose. There is no analytics or tracking beyond what is listed here.
            </p>
          </Section>

          <Section id="processors">
            <List
              items={[
                <>
                  <strong>Clerk</strong>: sign-in and accounts.
                </>,
                <>
                  <strong>Google</strong>: “Continue with Google” sign-in, if you use it (we receive your name, email and picture).
                </>,
                <>
                  <strong>Vercel</strong>: hosting, and the sandboxes your experiments run in.
                </>,
                <>
                  <strong>Neon</strong>: the database holding your sessions and runs.
                </>,
                <>
                  <strong>Groq</strong>: runs the AI models. Agents that read your data (to understand the table) send it a sample of rows.
                </>,
                <>
                  <strong>Google Gemini</strong>: a fallback AI model, used for writing code, judging and reporting. It never receives rows from your data, only
                  column names, statistics, code and results. It is used on Google’s free tier, under which Google may use prompts to improve its products.
                </>,
              ]}
            />
            <p>
              Don’t use AutoTinker with personal, confidential or regulated data (health records, financial details, anything about identifiable people). It is
              a research demo, not a place for sensitive data.
            </p>
          </Section>

          <Section id="cookies">
            <p>
              Clerk sets cookies to keep you signed in. If you used AutoTinker before signing in, a signed cookie identified your browser’s sessions; it is
              removed once those sessions move to your account. No advertising or tracking cookies.
            </p>
          </Section>

          <Section id="retention">
            <p>
              Sessions and runs are kept until you ask us to delete them or the project shuts down. Uploaded files are not kept. Rate-limit records last at most
              an hour; hosting logs follow Vercel’s retention.
            </p>
          </Section>

          <Section id="choices">
            <p>
              You can ask for a copy of your data, or for your account and all your sessions and runs to be deleted, by emailing{" "}
              <a href={`mailto:${CONTACT}`}>{CONTACT}</a> from the address you sign in with. We’ll do it within 30 days. You can stop using AutoTinker at any
              time; replays can be watched without an account.
            </p>
          </Section>

          <Section id="children">
            <p>AutoTinker is not meant for anyone under 13, and we don’t knowingly collect their data.</p>
          </Section>

          <Section id="changes">
            <p>If this policy changes, this page and its date change with it. Material changes will be noted here before they take effect.</p>
          </Section>

          <p className="pv-end">
            Questions: <a href={`mailto:${CONTACT}`}>{CONTACT}</a> · <Link href="/">Back to AutoTinker</Link>
          </p>
        </article>
      </div>
    </main>
  );
}
