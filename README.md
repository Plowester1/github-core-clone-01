# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Plowester1/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Plowester1/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, single-process GitHub-compatible git forge written in TypeScript on Node 22 with only the standard library: git smart HTTP (upload-pack protocol v2, receive-pack v0, hand-rolled packfiles and delta application), the REST v3 API, GraphQL v4, and an MCP endpoint over Streamable HTTP — all served from one in-memory store, with no git binary, no UI, and no outside service.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=test-token MAKEFUN_ENV_URL=http://127.0.0.1:8080 node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=dqsr3f0k&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
