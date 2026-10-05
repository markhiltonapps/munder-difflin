# Engine usage metering: OpenCode and Gemini CLI

Evidence gathered 2026-10-05 from the published npm packages (unpacked and, where possible, executed under an isolated HOME). Versions inspected: **opencode-ai 1.18.34** (binary `opencode-linux-x64@1.18.34`, Bun single-file executable with embedded JS) and **@google/gemini-cli 0.62.0** + **@google/gemini-cli-core 0.62.0**.

---

## 1. OpenCode (`opencode-ai` 1.18.34)

### Where

Current versions store everything in **one SQLite database** (bun:sqlite + drizzle, WAL mode). The old `storage/session/...json` tree is gone; a `Storage.migration.1` routine imports it into the DB on first run.

- Data dir = `$XDG_DATA_HOME/opencode` or `~/.local/share/opencode` on **every OS** (xdg-basedir logic; on Windows this is `%USERPROFILE%\.local\share\opencode`, not `%LOCALAPPDATA%`). `OPENCODE_TEST_HOME` overrides home.
- DB file: `<data>/opencode.db` (plus `opencode.db-wal`, `opencode.db-shm`). Env `OPENCODE_DB` overrides the path; non-release channels use `opencode-<channel>.db`.
- `opencode db path` prints the resolved path; `opencode db "<sql>" --format json` runs ad-hoc SQL (verified).

Tables (from `sqlite_master` of a freshly created DB):

```sql
CREATE TABLE `project` (`id` text PRIMARY KEY, `worktree` text NOT NULL, `vcs` text, `name` text, ...,
  `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `sandboxes` text NOT NULL, `commands` text);
CREATE TABLE `project_directory` (`project_id` text, `directory` text, `type` text, `strategy` text, `time_created` integer, PRIMARY KEY(project_id, directory));
CREATE TABLE `session` (`id` text PRIMARY KEY, `project_id` text NOT NULL, `workspace_id` text, `parent_id` text,
  `slug` text, `directory` text NOT NULL, `path` text, `title` text, `version` text, `share_url` text, ...,
  `cost` real DEFAULT 0, `tokens_input` integer DEFAULT 0, `tokens_output` integer DEFAULT 0,
  `tokens_reasoning` integer DEFAULT 0, `tokens_cache_read` integer DEFAULT 0, `tokens_cache_write` integer DEFAULT 0,
  `agent` text, `model` text /*json {id,providerID,variant}*/, `time_created` integer, `time_updated` integer, `time_compacting` integer, `time_archived` integer);
CREATE TABLE `message` (`id` text PRIMARY KEY, `session_id` text NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL /*json*/);
CREATE TABLE `part`    (`id` text PRIMARY KEY, `message_id` text NOT NULL, `session_id` text NOT NULL, `time_created` integer, `time_updated` integer, `data` text NOT NULL /*json*/);
```

Timestamps are epoch **milliseconds**. IDs are `ses_`/`msg_`/`prt_` + 12 hex chars (time-sortable, ms*4096+counter) + 14 random alphanumerics.

### Schema (assistant message)

`message.data` is the message *info* object with `id` and `sessionID` stripped (`({id, sessionID, ...rest}) => rest`); read them from the columns. The `AssistantMessage` schema in the bundle:

```json
{ "role": "assistant", "parentID": "msg_...", "mode": "build", "agent": "build",
  "modelID": "claude-sonnet-4-5", "providerID": "anthropic", "variant": "high",
  "path": { "cwd": "/repo/sub", "root": "/repo" },
  "cost": 0.0123,
  "tokens": { "total": 1234, "input": 1000, "output": 200, "reasoning": 34,
              "cache": { "read": 800, "write": 100 } },
  "time": { "created": 1759700000000, "completed": 1759700012000 },
  "finish": "stop", "summary": false, "error": { "name": "...", "data": {} }, "structured": null }
```

Exact paths: `tokens.input`, `tokens.output`, `tokens.reasoning`, `tokens.cache.read`, `tokens.cache.write`, `tokens.total` (optional), `cost` (USD, computed by OpenCode from models.dev pricing), `modelID`, `providerID`, `role`, `time.created`, `time.completed` (optional), `finish` (optional), `error` (optional). Finished message = `time.completed` present (or `finish`/`error` set). `summary: true` marks compaction messages (their tokens are real API usage and should still be counted). Per-step usage also exists in `part.data` where `type == "step-finish"` with `cost` and the same `tokens` shape; the session-level `tokens_*`/`cost` columns are running sums maintained from those parts.

Query:

```sql
SELECT m.id, m.session_id, m.time_created, m.time_updated, m.data
FROM message m WHERE json_extract(m.data,'$.role')='assistant' AND m.time_updated > ?;
```

### Session -> agent mapping

- `session.directory` = cwd the session was started in; `session.project_id` -> `project.worktree` (git top-level). `project.id` is resolved as: git `origin` remote hash (`git-remote:<host>/<owner>/<repo>`) ?? contents of `<git-common-dir>/opencode` ?? first root commit sha ?? `"global"` (non-git dirs; worktree is `/`). `session.parent_id` links subagent sessions to their parent.
- `opencode run --format json` prints JSONL events, every line carrying `"sessionID"` (e.g. `{"type":"session.created"...}`), so the app can capture the id from stdout. `opencode run -s <id>` / `--continue` resume; `opencode session list --format json` and `opencode export <sessionID>` dump sessions. No env var exposes the id; `OPENCODE_WORKSPACE_ID` is unrelated.

### Recommended approach

Open `opencode.db` read-only (`?mode=ro`, `immutable` is unsafe because of WAL; use a normal read-only connection so the WAL is honoured) and poll `message` by `time_updated > last_seen` for `role='assistant'`; join `session` for `directory`/`project_id`; dedupe on `message.id` and treat a row as final when `data.time.completed` exists. Map session -> agent via the `sessionID` captured from `--format json` output (preferred) or by `session.directory` + `time_created` window (fallback). Alternatively, shell out to `opencode db "<sql>" --format json` to avoid shipping a SQLite driver.

### Caveats / version

- Schema is drizzle-migrated and evolving (`__drizzle_migrations` table); `session_message`/`session_entry` tables also exist but `message` is the one the Session service reads. Pin on `message.data` keys above, which match the public SDK types.
- `cost` is OpenCode's own estimate; recompute from tokens if you want your own pricing.
- Windows path is `~/.local/share`, not AppData.
- Older installs (< 1.x) used `storage/session/{info,message,part}/...json` under the same data dir; those are migrated on first run and are not maintained.

---

## 2. Gemini CLI (`@google/gemini-cli` 0.62.0)

### Where

Global dir `~/.gemini` (override: `GEMINI_CLI_HOME`; under macOS `sandbox-exec` runtime state moves to `~/.cache/.gemini`). Project state lives under `~/.gemini/tmp/<project-slug>/` where the slug comes from `~/.gemini/projects.json` (`{"projects": {"<abs path>": "<slug>"}}`), slug = lowercase `basename(cwd)` with non-alnum -> `-`, suffixed `-1`, `-2` on collision; each slug dir holds a `.project_root` file containing the absolute path. The pre-0.6x layout `~/.gemini/tmp/<sha256(cwd)>/` is migrated automatically. Chats: `~/.gemini/tmp/<slug>/chats/session-<YYYY-MM-DDTHH-mm>-<first 8 of sessionId>.jsonl` (subagents: `chats/<parentSessionId>/<sessionId>.jsonl`). Older sessions may still be `.json` (whole-object) files; the service converts them to `.jsonl` on resume. Chat recording is always on (only disabled on ENOSPC). Verified by running the CLI with a fake key:

```
~/.gemini/projects.json
~/.gemini/tmp/proj-sample/.project_root
~/.gemini/tmp/proj-sample/chats/session-2026-10-05T21-32-0f0e0d0c.jsonl
```

### Schema (chats .jsonl)

Line 1 is metadata; later lines are either a full `MessageRecord` (re-appended whenever it changes; **last write for an `id` wins**), or `{"$set": {...}}` metadata patches, or `{"$rewindTo": "<id>"}`:

```json
{"sessionId":"0f0e0d0c-1111-4222-8333-444455556666","projectHash":"4ea86ddd…855e","startTime":"2026-10-05T21:32:45.890Z","lastUpdated":"…","kind":"main"}
{"id":"53b3cda7-…","timestamp":"2026-10-05T21:32:46.379Z","type":"user","content":[{"text":"hi"}]}
{"id":"…","timestamp":"…","type":"gemini","content":[{"text":"…"}],"model":"gemini-2.5-pro",
 "tokens":{"input":1234,"output":56,"cached":1000,"thoughts":40,"tool":0,"total":1330},
 "toolCalls":[{"id":"…","name":"read_file","args":{},"status":"success","timestamp":"…"}]}
```

`tokens` is populated by `recordMessageTokens(usageMetadata)`: `input = promptTokenCount`, `output = candidatesTokenCount`, `cached = cachedContentTokenCount`, `thoughts = thoughtsTokenCount`, `tool = toolUsePromptTokenCount`, `total = totalTokenCount`. It is attached to the last `type:"gemini"` message **after** the stream finishes (one usage object per API call; a multi-tool turn produces several gemini messages). `model` is the *requested* model name. `projectHash` = `sha256(projectRoot)` hex (verified).

### Telemetry (local file)

In 0.62 there are **no `--telemetry*` CLI flags** any more; configure via `settings.json` or env vars (env wins over settings):

```json
{ "telemetry": { "enabled": true, "target": "local", "outfile": "/path/gemini-otel.json", "logPrompts": false } }
```

Env: `GEMINI_TELEMETRY_ENABLED=true`, `GEMINI_TELEMETRY_TARGET=local`, `GEMINI_TELEMETRY_OUTFILE=<path>`, `GEMINI_TELEMETRY_LOG_PROMPTS=false` (also `GEMINI_TELEMETRY_OTLP_ENDPOINT/PROTOCOL`, `_USE_COLLECTOR`, `_USE_CLI_AUTH`, `_TRACES_ENABLED`). Defaults: `enabled=false`, `target=local`, `logPrompts=true` (set it false or prompts/responses land in the file), `otlpEndpoint=http://localhost:4317`; when `outfile` is set it takes precedence over the OTLP endpoint. The file is opened in append mode and receives spans, log records **and** metrics as **pretty-printed JSON objects concatenated with newlines (not JSONL)**; each object is the raw OTel SDK structure (`hrTime`, `resource._rawAttributes`, `attributes`, `_body`, `instrumentationScope`). Parse with a brace-depth splitter.

Per-call record: log with `attributes["event.name"] == "gemini_cli.api_response"` and attributes `session.id`, `installation.id`, `interactive`, `event.timestamp`, `model` (the served `modelVersion`), `duration_ms`, `input_token_count`, `output_token_count`, `cached_content_token_count`, `thoughts_token_count`, `tool_token_count`, `total_token_count`, `prompt_id`, `auth_type`, `status_code`, `finish_reasons`, `role`; `response_text` only when `logPrompts` is true. A parallel `gen_ai.client.inference.operation.details` record carries `gen_ai.usage.input_tokens/output_tokens`. Metric `gemini_cli.token.usage` (attributes `model`, `type` in `input|output|cache|thought|tool`) is also written, but with **CUMULATIVE** temporality every 10 s, so it is a running total, not per turn. Resource attribute `session.id` is on every record.

### Session -> agent mapping

Pass `--session-id <uuid>` when spawning (`gemini -p ... --session-id <uuid>`; errors if the id already exists). That uuid is the chats `sessionId`, the first 8 chars of the chats filename, and `session.id` on every telemetry record. `--output-format json` also prints `{"session_id": ..., "response": ..., "stats": {models: {<model>: {tokens: {input,prompt,candidates,total,cached,thoughts,tool}}}}}` at the end (`stream-json` emits JSONL events with the same stats). `--resume <id|latest|n>` resumes. Project is identified by `.project_root` / `projects.json`, or by hashing cwd with sha256 for `projectHash`.

### Recommended approach

Use the **chats .jsonl** as the primary source: it is always written, is per-message, and already carries the exact `usageMetadata` split plus `model`. Tail `~/.gemini/tmp/<slug>/chats/session-*-<id8>.jsonl`, apply records in order (full-record lines replace by `id`; `$set` patches metadata), and meter each `type:"gemini"` record once its `tokens` appears. Use the telemetry outfile only as a cross-check or when you need `duration_ms`/served model version; it requires opting in, logs prompts by default, and needs a non-JSONL parser.

### Caveats / version

- Chats `tokens` are per API response; a tool loop yields several gemini records. Records may be rewritten (same `id`) so dedupe by id, not by line.
- Legacy `.json` chat files (pre-jsonl) are a single `ConversationRecord` object with a `messages` array of the same shape.
- The telemetry BatchLogRecordProcessor flushes on shutdown; on a fatal-error exit the `api_error` record was not written in my test, so file telemetry can miss the final events of a crashed run.
- Resuming a session via `--session-file` creates a **new** session id and file.
- The CLI refuses untrusted directories in headless mode unless `GEMINI_CLI_TRUST_WORKSPACE=true` or `--skip-trust` is used.
