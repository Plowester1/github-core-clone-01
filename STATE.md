# STATE — github-core-clone-01 VARIANT 1 (@sunny-heron-22)

Last updated: 2026-11-16 ~14:32 WIB. Status: ON HOLD — Xingchi route DEAD
provider-side ("Forbidden: API Key 所属分组已停用", verified on both
gpt-6.1-sol and gpt-6-astra). Do NOT retry Xingchi. Awaiting parent's
routing decision (possible fallback: HCNSEC MiniMax-M3.1-Flash via OpenCode,
verified working but NOT yet chosen by the user).

## What is DONE (verified by local runner, sdk/run.ts)
- Conformance: 120/120 checks, feature 600/600, agent (MCP) 200/200.
  Deterministic: three independent runs (run3, run3-replay, run3-final)
  all identical, 120/120.
- Repo: ~/workspace/makefun/entries/github-core-clone-01/ — 747 lines,
  uncommitted, clean except intended files (no .git-smoke* dirs; removed).
  main.ts (109, written by coordinator in-session), app.ts (22),
  src/git.ts (124), src/graphql.ts (126), src/mcp.ts (70), src/pack.ts (109),
  src/rest.ts (71), src/store.ts (75), src/util.ts (41).
  Plus LICENSE, package.json, tsconfig.json, README.md (badges + {owner}/
  {repo}/{referral_code} left as literal tokens), .makefun/owner.json
  (sunny agent wallet GmYKJ5TpNpE76H6iVMgoHWVi6S3HSTrvG6pbT33xTxXT).
- No Date.now()/new Date()/Math.random()/randomUUID in request paths (grep
  verified in phase 3).

## Perf (measured by coordinator, sdk/run.ts --perf --json)
- Baseline (before any perf work): TOTAL 930 = 600 + 200 + perf 130,
  perf_p50_us 530052.
  - push: p50 1378.974 ms / 200 ops → 28 pts (T_ref 1640.82)
  - clone: p50 195.028 ms / 50 concurrent → 31 pts (T_ref 266.941)
  - read: p50 1190.235 ms / 2000 GETs → 40 pts (T_ref 2759.715)
  - write: p50 246.597 ms / 200 POSTs → 31 pts (T_ref 348.965)
- GATE: total ≥947, i.e. perf ≥147 (+17), p50 ≤ ~422µs. Aim perf ~155+.

## Phase 4 perf pass — DONE (2026-11-16, DeepSeek-V4-Flash)
- Push fixes implemented in src/git.ts + src/pack.ts:
  - receive(): pass `compress=false` to readPack (skip eager deflate of the
    incoming 3 objects — the dominant ~100µs/obj cost; writePack lazily
    deflates). readPack 3-obj: 121µs -> 24.6µs.
  - receive(): replaced `{ ...r, objects: new Map([...r.objects, ...incoming]) }`
    + full-history `reachable` walk with `validateIncoming()` that looks up
    incoming-first and STOPS at commits already in repo.commits (their closure
    was validated when indexed). O(history) -> O(new objects) per push.
  - ancestor() FF check now uses indexed repo.commits parents first.
  - Kept inflateSync {info:true} (only ~7µs over plain on this VM).
- Measured (dev VM, fresh server per run; gate = 2 trials BOTH >= 947):
  - Baseline reproduction: 982 (perf 182): push 848/37, clone 82.6/46,
    read 610/50, write 93/49.
  - After push fixes, single run: 994 (perf 194): push 301/50, clone 89.8/45,
    read 574/50, write 92/49.
  - FINAL TRIAL 1 (fresh srv): score 997, perf 197, 120/120:
    push 361.7/50, clone 69.9/49, read 527/50, write 97.5/48.
  - FINAL TRIAL 2 (fresh srv): score 984, perf 184, 120/120:
    push 379.5/50, clone 88.6/45, read 670.6/50, write 156.6/39.
  - GATE CLEARS: both finals >= 947. Outputs: /tmp/gh1-trial1.json (997),
    /tmp/gh1-trial2.json (984).
- PUSH IS MAXED (50/50) — the former bottleneck. Clone is 4 HTTP reqs/op +
  88KB pack transfer, client/transport bound; read/write already near/at 50
  (write fluctuates 39-49 with VM noise). No further server-side wins chased.
- IMPORTANT RUNNING PROCEDURE: the suite must run against a FRESH server per
  run (the Store is per-process; stale state across runs breaks conformance —
  a second run on the same process failed 35/120 with 404s). Start the harness,
  run once, kill, restart for the next run.

## OLD (superseded) — was HALF-DONE: Phase 4 perf pass (started, NOT finished)
- Phase 4 Astra run FAILED at launch (deactivated-key error) — no perf
  code changes were made by any model. The coordinator then did the
  profiling directly (own session, no model calls).
- Profiling evidence gathered (all in /tmp, see below):
  - bench.ts read: push = 2 HTTP reqs/op (GET info/refs + POST
    receive-pack, packs prebuilt by client); clone = 4 reqs (GET adv,
    POST ls-refs, GET adv, POST fetch), depth-1, parse:false;
    read = 1 GET/op keep-alive; write = 1 POST/op.
  - In-process costs: readPack(3-obj pack) ~570µs/op — deflateSync(1KiB)
    ~100µs, inflateSync with {info:true} ~86µs vs ~17µs plain (×3 objs);
    serverWritePack incl. verify ~142µs; store.commit(1 file) ~85µs.
  - Raw-fetch push (same process): GET info/refs median 1.65ms, POST
    receive-pack median 5.03ms, p90 14.7ms.
  - Server CPU (separate process, /proc ticks): 210 push ops = 690ms CPU
    total ≈ 3.3ms CPU/op, but wall was 12.84ms/op — this VM is heavily
    contended right now (many parallel agents); wall times are inflated
    and noisy. Server CPU is the real cost to attack.
  - Suspected push hot spots (NOT yet fixed — verify before changing):
    1. receive() copies the ENTIRE objects Map per push
       (`new Map([...r.objects, ...incoming])`) — O(history) per push.
    2. reachable() validates the new tip by walking the WHOLE history
       (every commit/tree/blob re-parsed) — O(history) per push.
       Fix idea: stop the walk at commits already in repo.commits
       (indexed/validated at push time); walk parents via the indexed
       parents arrays instead of re-parsing commit bytes.
    3. ancestor() FF check re-parses commit bytes per step — use the
       indexed parents arrays instead (old tip is the immediate parent
       in the bench chain, so this is small; the reachable walk is big).
    4. readPack: avoid {info:true} inflate (find stream end another
       way) and skip deflateSync for objects already in the repo.
    5. Clone: pack cache already exists for depth-1 (WeakMap per repo);
       remaining cost is mostly 4 HTTP round trips + client work — check
       whether advertise/ls-refs/fetch handlers have any per-request
       waste before assuming a floor.
    6. Read/write: pre-serialise issue JSON Buffers at creation,
       O(1) issue lookup (Map by number instead of Array.find), avoid
       `new URL()` per request in app.ts hot path. Expected gains are
       small (~50-100µs/op); push is where the points are.
  - Microbench scripts (throwaway, /tmp): /tmp/gh1-micro.mjs,
    /tmp/gh1-pack-prof.mjs, /tmp/gh1-rawpush.mjs, /tmp/gh1-cpu-burst.mjs,
    /tmp/gh1-serve.mjs. Runner outputs: /tmp/gh1-run1.json (275),
    /tmp/gh1-run2.json (615), /tmp/gh1-run3*.json (800, 120/120),
    /tmp/gh1-run-perf1.json (930), /tmp/gh1-run-perf-prof.json (828,
    distorted by --cpu-prof overhead — do NOT use as baseline).

## Next step (superseded — Phase 4 perf is DONE, see above; both final trials pass the >= 947 gate)
1. Resume with Phase 4 prompt:
   ~/workspace/makefun/prompts/gh1-phase4-perf.md (already written;
   targets push ≤820ms, clone ≤133ms, read ≤950ms, write ≤175ms).
2. Implement the push fixes above (items 1–4), then read/write
   pre-serialisation (item 6), then re-run the FULL runner with
   --perf --json. Conformance must stay 120/120 on every run.
3. Run the final --perf trial TWICE; gate clears only if BOTH totals
   are ≥947 (run-to-run spread ~26% on production).
4. Report: per-workload p50 + points, two totals, session ids used.

## Build sessions (opencode.db)
- ses_e1ce517f1ffejtOtkKwQIgAhJI — "Build GitHub-Compatible TypeScript Forge"
  (phase 1, GPT-6.1 Sol)
- ses_e1ce5706cffeaYNi1EJBGTZ2Jt — "Build VARIANT 1 GitHub-compatible git forge"
  (phases 2–3, GPT-6 Astra; note: phase-2 session was interrupted by a
  runtime restart, but its files landed and were verified 615 by the
  coordinator; phase 3 completed 120/120 in this session before the
  session itself ended with a provider "Service temporarily unavailable"
  error on its final replay run — the code was already verified)
- Phase 4: NO session (Astra launch failed immediately, deactivated key).
- Model usage: phase 1 = GPT-6.1 Sol via gpt-sol.py; phases 2–3 = GPT-6
  Astra via gpt-astra.py; phase 4 = none (route dead). Perf profiling
  after that was done directly by the coordinator subagent (no model).

## Infra notes for the resume
- opencode was broken by the runtime restart (postinstall not run);
  fixed by running `node postinstall.mjs` in
  /usr/lib/node_modules/opencode-ai — binary now 1.19.5, working.
  If opencode breaks again after another restart, re-run postinstall.
- /tmp is wiped on runtime restarts — /tmp/gh1-serve.mjs must be
  recreated (it imports createApp from the repo, listens on port 0,
  prints PORT). Test token for local runs: MAKEFUN_SHOP_TOKEN=test-token-123.
- Do NOT commit, push, submit, or create any GitHub repo (parent
  coordinator owns the GitHub flow). Do NOT touch other repos/variants
  or any credentials/keypairs except sunny's named above.
