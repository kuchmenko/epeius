# AI reviewer rollout and benchmark

Codex, CodeRabbit, Greptile, and Kodus are advisory reviewers. They must not be required checks or gain authority to merge, approve, request changes, push fixes, or handle repository secrets.

## Trigger contract

Each reviewer must skip draft pull requests, start when a pull request becomes ready for review, and review every later pushed head. Repository files establish this behavior for CodeRabbit, Greptile, and Kodus. Codex automatic review and GitHub App access are configured outside this repository.

Kodus additionally requires these repository settings:

- `kodusConfigFileOverridesWebPreferences` enabled so `kodus-config.yml` is read;
- BYOK provider OpenRouter with DeepSeek V4.1 Flash and high thinking effort, with its credential stored in Kodus.

No repository workflow consumes `OPENROUTER_API_KEY`. GitHub Actions secrets are not exposed to GitHub Apps, pull requests, logs, or checked-in reviewer configuration.

After AGENTS import or sync, inspect Kodus's converted rules against the checked-in source. Do not assume an LLM conversion preserved exact requirements.

This bootstrap pull request is not benchmark evidence. Reviewer configuration is read from different branches at different times, so first merge it, then open a separate disposable canary pull request.

## Canary procedure

1. Start a draft pull request containing small, deliberate, independently understood defects across Go, TypeScript, Solidity, and harness code. Do not place secrets or live transaction capability in it.
2. Confirm no reviewer runs while draft.
3. Mark the pull request ready and record each review's start and finish time, reviewed head SHA, comments, and status.
4. Classify every finding before changing code. Push fixes plus one new deliberate defect in a later commit.
5. Confirm each reviewer evaluates the new head, does not repeat fixed findings as current, and finds or misses the new defect.
6. Close the canary without merging. Remove any canary branch after evidence has been retained.

Use defects where correct and incorrect behavior differ on asymmetric inputs: values above 2^53, equal-output tie order under reversed completion, partial-search status, approval followed by fresh preparation, an unknown result after wallet handoff, partial router input consumption, floor-after-sum allocations such as 37/64, or a harness write missing its broadcast gate.

## Record

For each reviewer and commit, record:

- valid findings: reachable issue, violated contract, and decisive evidence;
- invalid findings: contradicted by code, tests, docs, or current requirements;
- duplicates: same issue already reported by another reviewer;
- unique valid findings found by no other reviewer;
- stale findings attached to code absent from the reviewed head;
- repeated findings after a fixing commit;
- time to first useful finding and time to completion;
- failed, skipped, or incomplete runs;
- available token or monetary cost, without estimating missing data.

Keep raw counts and links. Do not collapse results into one score that hides false positives or failed runs. After at least three representative pull requests, keep, tune, or disable each reviewer based on valid unique findings, noise, latency, failure rate, and cost. Never weaken deterministic CI because an AI reviewer usually catches the same defect.
