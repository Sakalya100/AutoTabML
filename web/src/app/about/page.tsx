import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

/**
 * A plain, fast, public page that says what AutoTinker is and why it asks for sign-in data. Server-rendered with no
 * client JavaScript, so link checkers and reviewers (e.g. Google's OAuth brand verification, which requires a
 * homepage that explains the app, its use of user data, and links the privacy policy) always get a readable page.
 */
export const metadata: Metadata = {
  title: "About",
  description: "AutoTinker builds and tests prediction models for tabular data with AI agents, and tells you honestly how good they are.",
};

const CONTACT = "sakalyamitra@gmail.com";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="font-display text-[1.6rem] leading-tight text-ink">{title}</h2>
      <div className="mt-3 space-y-3 text-[15.5px] leading-relaxed text-ink-2">{children}</div>
    </section>
  );
}

export default function AboutPage() {
  return (
    <main className="mx-auto max-w-[42rem] px-5 py-16 sm:px-6">
      <p className="font-mono text-[11.5px] tracking-[0.2em] text-ink-3 uppercase">About AutoTinker</p>
      <h1 className="mt-4 font-display text-[clamp(2.2rem,5vw,3.2rem)] leading-[1.05] text-ink">Paste a CSV link. Get a prediction model you can trust.</h1>
      <p className="mt-5 text-[16px] leading-relaxed text-ink-2">
        AutoTinker is a free web app for building machine-learning models on tabular data. You give it a table (a public CSV link or a small upload) and choose
        the column to predict. A team of AI agents then plans, writes and tests model code, keeps a change only when the improvement is statistically real, and
        stops when further gains are just noise. You get the model, its code, charts, and a plain-language report on how well it will do on data it has never
        seen.
      </p>

      <Section title="What it does">
        <ul className="list-disc space-y-2 pl-5">
          <li>Reads your table, suggests what to predict and how to score it (for example ROC-AUC or RMSE).</li>
          <li>Runs each experiment in an isolated sandbox and records every idea, its code and its score.</li>
          <li>Keeps an idea only if it wins a corrected statistical test across the same cross-validation folds.</li>
          <li>Scores the final model once on a held-back test set and reports how much the search fooled itself.</li>
          <li>Lets you steer or stop the agents while they work, and download the fitted model and its Python code.</li>
        </ul>
      </Section>

      <Section title="Why we ask you to sign in, and what we use">
        <p>
          Signing in (with Google, or with a one-time code sent to your email) only lets us save your sessions and runs to your account, so you can come back to
          them and download your models. From Google we receive your name, email address and profile picture, and use them only to identify your account and
          show who is signed in. We don’t access any other Google data, we don’t send email beyond sign-in codes, and we never sell or share your data.
        </p>
        <p>
          Datasets you analyse are processed in a per-run sandbox and not kept; the results of your runs are stored in your account. Full details are in the{" "}
          <Link href="/privacy" className="text-ink underline decoration-rule-strong underline-offset-4 hover:decoration-best">
            privacy policy
          </Link>
          .
        </p>
      </Section>

      <Section title="Who makes it">
        <p>
          AutoTinker is a personal, non-commercial project by Sakalya Mitra. The source code is public on{" "}
          <a href="https://github.com/Sakalya100/AutoTinker" className="text-ink underline decoration-rule-strong underline-offset-4 hover:decoration-best">
            GitHub
          </a>
          . Questions or data requests:{" "}
          <a href={`mailto:${CONTACT}`} className="text-ink underline decoration-rule-strong underline-offset-4 hover:decoration-best">
            {CONTACT}
          </a>
          .
        </p>
      </Section>

      <p className="mt-12 flex flex-wrap gap-x-6 gap-y-2 text-[14px] text-ink-3">
        <Link href="/" className="underline underline-offset-4 hover:text-ink">
          Open AutoTinker
        </Link>
        <Link href="/replays" className="underline underline-offset-4 hover:text-ink">
          Watch a recorded run
        </Link>
        <Link href="/privacy" className="underline underline-offset-4 hover:text-ink">
          Privacy policy
        </Link>
      </p>
    </main>
  );
}
