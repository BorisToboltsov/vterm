import { describe, it, expect } from "vitest";
import {
  nextCommand,
  buildFeedback,
  isDangerousCommand,
  DIALOG_SYSTEM_SUFFIX,
  FEEDBACK_MAX_LINES,
} from "./aidialog";
import { REDACTED } from "./redact";
import type { AiExecResult } from "./api";

function res(over: Partial<AiExecResult> = {}): AiExecResult {
  return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...over };
}

describe("nextCommand", () => {
  it("returns the first runnable command block", () => {
    expect(nextCommand("Do this:\n```bash\napt update\n```")).toBe("apt update");
  });

  it("is null when the reply has no runnable command (loop ends)", () => {
    expect(nextCommand("All done — nginx is installed and running.")).toBeNull();
    expect(nextCommand("```json\n{}\n```")).toBeNull(); // non-shell block
  });

  it("ignores an unterminated (still streaming) fence", () => {
    expect(nextCommand("```bash\napt update")).toBeNull();
  });
});

describe("buildFeedback", () => {
  it("reports the exit status and the combined output", () => {
    const fb = buildFeedback("ls", res({ stdout: "a\nb", exitCode: 0 }));
    expect(fb).toContain("`ls`");
    expect(fb).toContain("exit 0");
    expect(fb).toContain("a\nb");
  });

  it("marks a timeout instead of an exit code", () => {
    expect(buildFeedback("sleep 99", res({ timedOut: true }))).toContain("timed out");
  });

  it("says (no output) for an empty result", () => {
    expect(buildFeedback("true", res())).toContain("(no output)");
  });

  it("redacts secrets in the output before it goes to the model", () => {
    const fb = buildFeedback("env", res({ stdout: "API_KEY=supersecret" }));
    expect(fb).toContain(REDACTED);
    expect(fb).not.toContain("supersecret");
  });

  it("clips very long output to the last N lines", () => {
    const many = Array.from({ length: FEEDBACK_MAX_LINES + 50 }, (_, i) => `line${i}`).join("\n");
    const fb = buildFeedback("cat big", res({ stdout: many }));
    expect(fb).toContain("earlier lines hidden");
    expect(fb).toContain(`line${FEEDBACK_MAX_LINES + 49}`); // last line kept
    expect(fb).not.toContain("line0\n"); // earliest dropped
  });
});

describe("isDangerousCommand", () => {
  it("flags destructive commands", () => {
    for (const c of [
      "rm -rf /",
      "rm -fr ~/data",
      "sudo mkfs.ext4 /dev/sda1",
      "dd if=/dev/zero of=/dev/sda",
      "reboot",
      "chmod -R 777 /etc",
      "echo x > /etc/passwd",
    ]) {
      expect(isDangerousCommand(c)).toBe(true);
    }
  });

  it("leaves ordinary commands alone", () => {
    for (const c of ["ls -la", "apt install nginx", "systemctl status nginx", "cat /etc/hosts"]) {
      expect(isDangerousCommand(c)).toBe(false);
    }
  });
});

describe("DIALOG_SYSTEM_SUFFIX", () => {
  it("tells the model to run one step at a time", () => {
    expect(DIALOG_SYSTEM_SUFFIX.toLowerCase()).toContain("one shell command at a time");
  });
});
