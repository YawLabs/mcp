// The one "Proceed? [Y/n]" question that consents to running a git repo's
// install and build scripts. buildGitSource asks it through
// GitBuildContext.confirm, once per repo, and every command that can build a
// git source hands it this same closure: `add --git` (local-add-cmd.ts),
// `update` (update-cmd.ts), `sidecars install` (sidecars-cmd.ts) and the build
// `trust` offers after a grant (trust-cmd.ts). One copy, so the three answers
// mean the same thing in all four:
//
//   bare Enter, y, yes   consent: the scripts run (the prompt is [Y/n])
//   ^D / stdin ran dry   decline: nothing is built (askYesNo's QUESTION_EOF,
//                        which can never equal "" -- EOF is not consent)
//   ^C                   "cancelled": buildGitSource fails with exit code 130
//                        and `cancelled: true`, and the command stops there
//                        and exits 130 (128 + SIGINT), as every other prompt
//                        in the CLI does for the same keystroke
//
// `read` is askYesNo's reader; only `trust` passes one (its raw-mode
// readTrustAnswer), everyone else reads through node:readline.

import type { GitBuildContext } from "./git-source.js";
import { type AnswerReader, askYesNo, QUESTION_CANCELLED, type YesNoOptions } from "./readline-question.js";

/** The question itself, after the consent screen's lines. */
export const SCRIPT_CONSENT_QUESTION = "Proceed? [Y/n] ";

/** The `confirm` for a GitBuildContext: print the consent screen, ask, and
 *  map the answer as the header above says. */
export function scriptConsentConfirm(
  opts: YesNoOptions,
  print: (line: string) => void,
  read?: AnswerReader,
): NonNullable<GitBuildContext["confirm"]> {
  return async (lines) => {
    for (const l of lines) print(l);
    const answer = await askYesNo(opts, SCRIPT_CONSENT_QUESTION, read);
    if (answer === QUESTION_CANCELLED) return "cancelled";
    return answer === "" || answer === "y" || answer === "yes";
  };
}
