# NanoClaw Migration Guide

Generated: 2026-04-27
Base: `a81e1651b5e48c9194162ffa2c50a22283d5ecd3` (last common ancestor with upstream/main)
HEAD at generation: `42008b8` (origin/main)
Upstream HEAD: `f8c3d023483c3775309d97b89638d96cded618df`

---

## Migration Plan

This fork added Slack as a first-class channel and bolted on Snowflake/GitHub MCP integrations on top of NanoClaw v1.x. Upstream has since moved to v2 with several breaking architectural changes:

- **Channels moved to a `channels` branch** — Slack reinstalls via `/add-slack`; it likely already includes thread support
- **Two-DB session split** (`inbound.db`/`outbound.db`) — replaces single `messages.db`; per-thread sessions need adapting
- **New entity model** — users/agent-groups separated; "main channel = admin" retired
- **Install flow replaced** — `bash nanoclaw.sh` is the new entry point
- **Logger replaced** — pino → built-in
- **Apple Container** opt-in only

**Order of staging (validate after each):**

1. Clean v2 base + reinstall Slack via `/add-slack`
2. Verify thread support and trusted-bot routing in v2's Slack — apply gaps only
3. Reapply per-thread sessions adapted for two-DB model (likely the biggest rework)
4. Reapply Snowflake MCP + key-pair auth
5. Reapply GitHub MCP if not already in upstream
6. Reapply remaining source customizations (idleWaiting fix if still relevant)
7. Copy persona content (`groups/global/CLAUDE.md`, `groups/main/CLAUDE.md`)
8. Carry data over (`groups/`, `store/messages.db` → migrate to two-DB if needed, `keys/`, `.env`)

**Risk areas to verify upstream-first before reapplying:**

- `idleWaiting` race condition — may have been fixed upstream independently
- `reply_thread_ts` plumbing — Slack's v2 channel branch likely carries thread support natively
- GitHub MCP — there's an `upstream/feat/add-github-skill` branch; the integration may now be a skill

---

## Applied Skills

Reapply by merging the upstream skill branch (or running the corresponding skill) on the clean v2 base:

- **`/add-slack`** — installs Slack channel from `upstream/channels` branch (was `slack/main` remote in v1; now consolidated upstream)

No locally-authored skills exist. All `.claude/skills/<name>/` files are upstream-shipped.

---

## Skill Interactions

None at present. The Slack channel is the only applied skill; all other customisations are direct source modifications around it.

---

## Modifications to Applied Skills

### Slack: `SLACK_TRUSTED_BOT_IDS` env var support

**Intent:** Workflow bots (e.g. airflow-notifications, database-update-form) trigger the agent automatically without needing an `@mention`. The `<@BOTID>` mention syntax doesn't work for bot messages, so we treat configured bot IDs as implicitly trusted.

**Files:** `src/channels/slack.ts`

**How to apply** (after `/add-slack` runs):

1. Add `SLACK_TRUSTED_BOT_IDS` to the `readEnvFile` call alongside the existing tokens:
   ```typescript
   const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_TRUSTED_BOT_IDS']);
   ```

2. In the `SlackChannel` constructor, parse the comma-separated list into a class field:
   ```typescript
   private trustedBotIds: string[] = [];
   // ...
   this.trustedBotIds = env.SLACK_TRUSTED_BOT_IDS
     ? env.SLACK_TRUSTED_BOT_IDS.split(',').map((s) => s.trim()).filter(Boolean)
     : [];
   ```

3. In the `app.event('message')` handler, after the `isBotMessage` check, derive `isTrustedBot` and let it bypass the `@mention` requirement:
   ```typescript
   const msgBotId = (msg as { bot_id?: string }).bot_id;
   const isTrustedBot =
     isBotMessage &&
     msg.user !== this.botUserId &&
     !!msgBotId &&
     this.trustedBotIds.includes(msgBotId);
   ```
   Then in the routing branch: bot messages from trusted IDs go through the same prepend-trigger flow as a real `@mention`, with `replyThreadTs = msg.thread_ts || msg.ts` and `senderName = await this.resolveBotName(msgBotId)`. Untrusted bot messages remain pass-through (context only, not a trigger).

4. `.env` needs `SLACK_TRUSTED_BOT_IDS=B01XXX,B02YYY,...` — comma-separated bot IDs.

### Slack: thread-routing customisations

These may already be in v2's Slack channel — verify first by reading `src/channels/slack.ts` after `/add-slack` runs and looking for `reply_thread_ts` field and `replyThreadTs` variable in the message handler.

If absent, apply the customisations from "reply_thread_ts plumbing" below for the slack-channel half. If present, no action needed for this skill.

---

## Customizations

### 1. `reply_thread_ts` plumbing (cross-cutting threading support)

**Intent:** When a Slack `@mention` arrives from inside a thread, the agent's reply must go back into that same thread, not the channel root. The thread-ts has to travel through every pipeline stage (channel → orchestrator → container → outbound queue → IPC) so the right thread is targeted even when multiple mentions are in flight simultaneously.

**Files:** `src/types.ts`, `src/db.ts`, `src/channels/slack.ts`, `src/router.ts`, `src/index.ts`, `src/group-queue.ts`, `src/ipc.ts`, `container/agent-runner/src/index.ts`, `container/agent-runner/src/ipc-mcp-stdio.ts`

**Status check before applying:** v2's `channels` branch likely already ships this. Read the v2 versions of these files first; only apply the gaps.

**How to apply (if needed):**

1. **`src/types.ts`** — add fields to existing interfaces:
   - `NewMessage`: `reply_thread_ts?: string`
   - `MessageSendOpts`: `threadTs?: string`

2. **`src/db.ts`** — column migration on `messages` table:
   ```typescript
   // Add reply_thread_ts column if it doesn't exist
   try {
     database.exec(`ALTER TABLE messages ADD COLUMN reply_thread_ts TEXT`);
   } catch { /* column already exists */ }
   ```
   Storage and retrieval functions need to set/read this column.

3. **`src/channels/slack.ts`** — capture thread context in the message handler:
   ```typescript
   replyThreadTs = (msg as { thread_ts?: string }).thread_ts || msg.ts;
   ```
   Pass it through `onMessage`. In `sendMessage`, accept `opts.threadTs` and pass to `chat.postMessage`'s `thread_ts` field.

4. **`src/index.ts`** — pass `replyThreadTs` from each message into the agent invocation; the `runAgent` signature carries it as the last argument.

5. **`src/router.ts`** — `MessageSendOpts` propagation; `formatOutbound` takes the threadTs.

6. **`src/ipc.ts`** — `sendMessage` accepts `{ threadTs?: string }` opts so IPC messages can target a thread.

7. **`container/agent-runner/src/index.ts`** — forward `replyThreadTs` from `ContainerInput` to a `NANOCLAW_REPLY_THREAD_TS` env var visible to the in-container MCP server.

8. **`container/agent-runner/src/ipc-mcp-stdio.ts`** — the in-container `send_message` MCP tool reads `NANOCLAW_REPLY_THREAD_TS` from env and includes `threadTs` in the JSON payload it writes to the host IPC dir.

### 2. Thread grouping logic (`src/index.ts`)

**Intent:** When the polling loop pulls multiple new trigger messages for a non-main group, and those messages came from *different* Slack threads in the same channel, we must invoke the agent *once per thread* rather than collapsing them into one prompt. Otherwise threaded responses get mis-routed.

**Files:** `src/index.ts`

**How to apply:**

In the message-processing path for non-main groups (around the section that handles "new trigger messages"), instead of one big agent invocation per group, group the trigger messages by `reply_thread_ts` and run `runAgent` once per distinct thread key. Each invocation carries that thread's `replyThreadTs` through to `runContainerAgent`.

Look for the existing comment: `Build thread groups — one agent invocation per distinct reply_thread_ts.` That section is the anchor. The structure roughly:

```typescript
const threadGroups = /* group triggers by t.reply_thread_ts (key undefined for non-thread) */;

for (let tIdx = 0; tIdx < threadGroups.length; tIdx++) {
  const { replyThreadTs, messages } = threadGroups[tIdx];
  const isLastThreadGroup = tIdx === threadGroups.length - 1;
  // ... build prompt from `messages`
  const output = await runAgent(group, prompt, chatJid, onOutput, replyThreadTs);
  // ... handle output, idle-notify only on isLastThreadGroup
}
```

Important detail: `notifyIdle` should only fire on the last thread group, otherwise idle cleanup races with subsequent thread invocations.

### 3. Per-thread session isolation (composite PK)

**Intent:** Each Slack thread keeps its own Claude Agent SDK session so context from thread A never leaks into thread B's responses. Previously all threads in a channel shared one session — caused the agent to confuse triage threads.

**Files:** `src/db.ts`, `src/index.ts`, `src/task-scheduler.ts`

**⚠️ v2 RISK:** v2 ships a two-DB session split (`inbound.db`/`outbound.db`). The composite-PK approach below is on a single-DB model. **This customisation likely needs the most rework against v2's structure.** Read v2's `docs/db-session.md` first; the implementation pattern below is preserved as reference but the actual reapply will need adapting.

**How to apply (single-DB version, for reference):**

1. **`src/db.ts`** — schema:
   ```sql
   CREATE TABLE IF NOT EXISTS sessions (
     group_folder TEXT NOT NULL,
     thread_ts TEXT NOT NULL DEFAULT '',
     session_id TEXT NOT NULL,
     PRIMARY KEY (group_folder, thread_ts)
   );
   ```
   Plus migration from old single-PK schema (rebuild via `sessions_new` → drop → rename), preserving existing rows with `thread_ts = ''`.

2. **`src/db.ts`** accessor signatures:
   - `getSession(groupFolder, threadTs = '')`
   - `setSession(groupFolder, threadTs, sessionId)`
   - `deleteSession(groupFolder, threadTs = '')`
   - `getAllSessions(): Record<string, Record<string, string>>` (nested)

3. **`src/index.ts`** — in-memory map becomes nested:
   ```typescript
   let sessions: Record<string, Record<string, string>> = {};
   ```
   In `runAgent`:
   ```typescript
   const threadKey = replyThreadTs || '';
   const sessionId = sessions[group.folder]?.[threadKey];
   ```
   All set/delete sites use the nested structure: `if (!sessions[group.folder]) sessions[group.folder] = {}; sessions[group.folder][threadKey] = output.newSessionId; setSession(group.folder, threadKey, output.newSessionId);`

4. **`src/task-scheduler.ts`** — scheduled tasks have no thread, use blank key:
   ```typescript
   const sessionId = task.context_mode === 'group'
     ? sessions[task.group_folder]?.['']
     : undefined;
   ```
   And update the `getSessions` type to `Record<string, Record<string, string>>`.

### 4. `idleWaiting` race condition fix

**Intent:** If a new message arrives while a container is in the idle-cleanup countdown, it has to interrupt the cleanup (close stdin to start fresh) rather than being silently buffered until the cleanup completes.

**Files:** `src/group-queue.ts`

**Status check before applying:** This may already be in upstream — `git log --grep idleWaiting` on upstream/main first.

**How to apply (if not already upstream):**

1. In the message-arrival path of `GroupQueue`, when the container is `active` and `idleWaiting`, immediately close stdin:
   ```typescript
   if (state.active) {
     state.pendingMessages = true;
     if (state.idleWaiting) {
       this.closeStdin(groupJid);
     }
     return;
   }
   ```

2. In `notifyIdle`, also close stdin if there are pending messages (not just pending tasks):
   ```typescript
   notifyIdle(groupJid: string): void {
     const state = this.getGroup(groupJid);
     state.idleWaiting = true;
     if (state.pendingTasks.length > 0 || state.pendingMessages) {
       this.closeStdin(groupJid);
     }
   }
   ```

### 5. Snowflake MCP integration

**Intent:** Agent has access to a Snowflake MCP server (`mcp__snowflake__*` tools) for querying the `ANALYTICS` and `REFINED` databases during analytics-DAG triage.

**Files:** `container/Dockerfile`, `container/agent-runner/src/index.ts`, `src/container-runner.ts`

**How to apply:**

1. **`container/Dockerfile`** — install Snowflake MCP server in a dedicated venv. The released PyPI version (0.4.0) doesn't support key-pair auth, so pin to the GitHub commit that introduced it:
   ```dockerfile
   RUN python3 -m venv /opt/snowflake-mcp && \
       /opt/snowflake-mcp/bin/pip install --no-cache-dir \
           "git+https://github.com/isaacwasserman/mcp-snowflake-server.git@9d6d93c0110d4e91baa8eaa7302de9927feb3036" \
           "pyopenssl>=24.0.0" && \
       chmod -R a+rx /opt/snowflake-mcp
   ```
   (The commit hash above is the current main as of guide-generation; bump it later if upstream releases a tagged version with key-pair support.)

2. **`src/container-runner.ts`** — read Snowflake env vars from `.env` and forward only what's set:
   ```typescript
   const {
     SNOWFLAKE_ACCOUNT, SNOWFLAKE_USERNAME, SNOWFLAKE_PASSWORD,
     SNOWFLAKE_PRIVATE_KEY_PATH, SNOWFLAKE_WAREHOUSE, SNOWFLAKE_ROLE,
     SNOWFLAKE_DATABASE, SNOWFLAKE_SCHEMA,
   } = readEnvFile([/* same names */]);
   if (SNOWFLAKE_PASSWORD || SNOWFLAKE_PRIVATE_KEY_PATH) {
     args.push('-e', `SNOWFLAKE_ACCOUNT=${SNOWFLAKE_ACCOUNT}`);
     args.push('-e', `SNOWFLAKE_USERNAME=${SNOWFLAKE_USERNAME}`);
     if (SNOWFLAKE_PASSWORD) args.push('-e', `SNOWFLAKE_PASSWORD=${SNOWFLAKE_PASSWORD}`);
     if (SNOWFLAKE_PRIVATE_KEY_PATH) args.push('-e', `SNOWFLAKE_PRIVATE_KEY_PATH=${SNOWFLAKE_PRIVATE_KEY_PATH}`);
     args.push('-e', `SNOWFLAKE_WAREHOUSE=${SNOWFLAKE_WAREHOUSE}`);
     args.push('-e', `SNOWFLAKE_ROLE=${SNOWFLAKE_ROLE}`);
     args.push('-e', `SNOWFLAKE_DATABASE=${SNOWFLAKE_DATABASE}`);
     args.push('-e', `SNOWFLAKE_SCHEMA=${SNOWFLAKE_SCHEMA}`);
   }
   ```

3. **`container/agent-runner/src/index.ts`** — gate the MCP server on either auth method, and only pass `--password` when set (the MCP reads `SNOWFLAKE_PRIVATE_KEY_PATH` from env directly):
   ```typescript
   ...(process.env.SNOWFLAKE_PASSWORD || process.env.SNOWFLAKE_PRIVATE_KEY_PATH ? {
     snowflake: {
       command: '/opt/snowflake-mcp/bin/mcp_snowflake_server',
       args: [
         '--account', process.env.SNOWFLAKE_ACCOUNT || '',
         '--user', process.env.SNOWFLAKE_USERNAME || '',
         ...(process.env.SNOWFLAKE_PASSWORD
           ? ['--password', process.env.SNOWFLAKE_PASSWORD]
           : []),
         '--warehouse', process.env.SNOWFLAKE_WAREHOUSE || '',
         '--role', process.env.SNOWFLAKE_ROLE || '',
         '--database', process.env.SNOWFLAKE_DATABASE || '',
         '--schema', process.env.SNOWFLAKE_SCHEMA || '',
       ],
     },
   } : {}),
   ```

4. Allowed tools list includes `'mcp__snowflake__*'` in the agent SDK options.

### 6. Snowflake key-pair auth (key file storage)

**Intent:** Service-account auth uses an RSA private key file (PKCS8 PEM) instead of a password. Key file lives outside the project in a gitignored `keys/` directory.

**Files:** `keys/snowflake.p8` (host), `.env`, `.gitignore`

**How to apply:**

1. **`.gitignore`** — under `# Secrets`, ensure these patterns are present:
   ```
   keys/
   *.p8
   *.pem
   ```

2. **Key file** — place the PKCS8 PEM-formatted key at `keys/snowflake.p8` (host path), permissions `chmod 600`. The container sees it at `/workspace/project/keys/snowflake.p8` since `/workspace/project` is mounted read-only.

3. **`.env`** — instead of `SNOWFLAKE_PASSWORD`, set:
   ```
   SNOWFLAKE_PRIVATE_KEY_PATH=/workspace/project/keys/snowflake.p8
   ```
   `SNOWFLAKE_USERNAME` should be the service-user name registered in Snowflake against this key's public half.

4. The MCP server reads `SNOWFLAKE_PRIVATE_KEY_PATH` from env, opens the file inside the container, and passes the key bytes to `snowflake-connector-python`'s `private_key=` arg.

### 7. GitHub MCP integration

**Intent:** Agent has access to GitHub MCP tools (`mcp__github__*`) for reading PRs, opening PRs, browsing repos during triage.

**Files:** `container/agent-runner/package.json`, `container/agent-runner/src/index.ts`, `src/container-runner.ts`

**Status check:** v2 may have this as `/add-github` — there's an `upstream/feat/add-github-skill` branch. Check first; if it's now a skill, apply via the skill rather than direct source edits.

**How to apply (direct version, if not a skill in v2):**

1. **`container/agent-runner/package.json`** — add dependency `@modelcontextprotocol/server-github` (was at `2025.4.8` when this fork captured it).

2. **`src/container-runner.ts`** — read and forward the PAT:
   ```typescript
   const { GITHUB_PERSONAL_ACCESS_TOKEN } = readEnvFile(['GITHUB_PERSONAL_ACCESS_TOKEN']);
   if (GITHUB_PERSONAL_ACCESS_TOKEN) {
     args.push('-e', `GITHUB_PERSONAL_ACCESS_TOKEN=${GITHUB_PERSONAL_ACCESS_TOKEN}`);
   }
   ```

3. **`container/agent-runner/src/index.ts`** — gate the MCP server on the env var, plus add `'mcp__github__*'` to allowed tools:
   ```typescript
   ...(process.env.GITHUB_PERSONAL_ACCESS_TOKEN ? {
     github: {
       command: 'node',
       args: ['/app/node_modules/@modelcontextprotocol/server-github/dist/index.js'],
       env: {
         GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN,
       },
     },
   } : {}),
   ```

### 8. jAI persona

**Intent:** Default assistant name is "jAI", not the upstream default "Andy".

**Files:** `groups/global/CLAUDE.md`, `groups/main/CLAUDE.md`

**How to apply:**

Copy the `groups/global/CLAUDE.md` and `groups/main/CLAUDE.md` files from the pre-migration state into the new tree. Both refer to the assistant as "jAI". The global file additionally contains guidance on `mcp__nanoclaw__send_message` vs normal reply (added in commit d734e6e) — this prevents the agent from sending duplicate messages by clarifying when to use `<internal>` tags to wrap recap text.

If `groups/main/CLAUDE.md` paths or section names have changed in v2, port the textual content (jAI persona + send_message guidance) into whatever the v2 equivalent is.

---

## Data preservation (NOT part of source migration — copy as-is across the swap)

These files/directories live outside source control and are preserved directly across the upgrade. The skill's swap step doesn't touch them.

| Item | Why preserve | Notes |
|---|---|---|
| `groups/slack_alarms-analytics/CLAUDE.md` | Triage instructions, subteam tag `<!subteam^S084RNFJVJQ\|@analytics-team-sentinel>`, PR-first workflow | Keep verbatim |
| `groups/slack_database-updates/CLAUDE.md` | DB-update PR triage, both subteam tags (analytics + platform `S06GS6P0ETG`) | Keep verbatim |
| `groups/slack_backstage-team-analytics/CLAUDE.md` | Main-channel persona | Keep verbatim |
| `store/messages.db` | Slack message history, registered groups, scheduled tasks (incl. `dbt-analytics-pr-summary`), sessions | **v2 splits into `inbound.db`/`outbound.db` — needs migration tool, not raw copy** |
| `keys/snowflake.p8` | Snowflake key-pair private key | `chmod 600`, gitignored |
| `.env` | All credentials (`SNOWFLAKE_*`, `GITHUB_PERSONAL_ACCESS_TOKEN`, `SLACK_*`, `ONECLI_*`, `SLACK_TRUSTED_BOT_IDS`) | Gitignored |
| `data/sessions/` | Per-group Claude session jsonl files | Carries forward unchanged |
| `logs/` | Service logs | Optional |

**Critical:** the `store/messages.db` migration to v2's two-DB model needs care — that's where the scheduled task for `dbt-analytics-pr-summary` lives, plus all message history. Don't lose this. Use whatever v2 migration tool exists (likely a script in `scripts/` or via `/setup`).
