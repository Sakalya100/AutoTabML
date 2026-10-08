import { describe, expect, it } from "vitest";
import { classifyMessage, isStopCommand, MAX_STEER_CHARS, sessionTitle, splitLink } from "@/lib/chat-input";

describe("message classification", () => {
  it("treats stop phrases as a control action during a run", () => {
    for (const t of ["stop", "Stop!", "  STOP now. ", "please stop", "That's enough", "wrap it up", "halt"])
      expect(classifyMessage(t, { runActive: true })).toEqual({ kind: "control", command: "stop" });
  });

  it("steers with anything else, including sentences that merely mention stopping", () => {
    for (const t of ["prefer simple linear models", "don't stop at trees, try boosting", "stop using deep models", "no target encoding"])
      expect(classifyMessage(t, { runActive: true }).kind).toBe("steer");
    expect(isStopCommand("stop using deep models")).toBe(false);
  });

  it("caps steers and is plain chat without a run", () => {
    const long = "x".repeat(MAX_STEER_CHARS + 50);
    const r = classifyMessage(long, { runActive: true });
    expect(r.kind === "steer" && r.text.length).toBe(MAX_STEER_CHARS);
    expect(classifyMessage("stop", { runActive: false })).toEqual({ kind: "chat", text: "stop" });
  });

  it("splits a pasted link from the sentence", () => {
    expect(splitLink("https://x.org/a.csv predict churn")).toEqual({ url: "https://x.org/a.csv", rest: "predict churn" });
    expect(splitLink("predict price https://x.org/h.csv.")).toEqual({ url: "https://x.org/h.csv", rest: "predict price" });
    expect(splitLink("no link here")).toEqual({ url: null, rest: "no link here" });
  });

  it("titles sessions from the goal, else the target", () => {
    expect(sessionTitle({ goal: "predict churn", target: "Churn" })).toBe("Predicting churn");
    expect(sessionTitle({ goal: "Which customers leave?", target: "Churn" })).toBe("Which customers leave");
    expect(sessionTitle({ goal: "", target: "house_price" })).toBe("Predicting house price");
  });
});
