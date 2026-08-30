# Command groups

`auth`, `config`, `sessions`, `invite`, `members`, `agents`, `assignments`, `routing`, `queue`, `chat`, `files`, `runs`, `conflicts`, `repository`, `skills`, `mcp`, `review`, `web`, and `doctor` mirror openfloor's existing member-authorized APIs.

- `auth login|status|logout`; `doctor`; `config show|set|clear`
- `sessions list|show|use|create|objective|archive|unarchive|lock|unlock|end|delete|leave`
- `invite show|rotate|revoke|join`; `members list|remove|restore`
- `agents list|show|create|edit|pause|resume|stop|delete|pause-all|resume-all|stop-all`
- `assignments set|clear`; `routing show|set`
- `queue list|show|add|target|edit|pause|resume|delete|move|run`
- `chat list|send`; `files list|upload|download`
- `runs list|show|watch|cancel|retry|discard|rollback|artifacts`; `conflicts list|show|answer|resolve`
- `repository show|options|connect|configure|disconnect|sync|tree|cat|candidate|preflight|logs`
- `skills list|add|remove`; `mcp list|add|edit|remove`
- `review status|files|prompts|diff|rollback-impact|rollback|ready|merge|delete-branch`
- `web onboarding|settings|billing|connections|github`

Global flags: `--session`, `--base-url`, `--json`, `--quiet`, `--no-color`, `--debug`, `--yes`.

IDs may be complete UUIDs or unique prefixes of at least eight characters. `--session` overrides the locally selected session. Long text accepts a positional value, `--file`, or piped stdin where offered.

`sessions create` fetches account-authorized GitHub repositories. One repository is selected automatically. Multiple repositories prompt in a TTY; noninteractive use must pass `--repository <owner/name-or-id>` and may pass `--installation <id>` when needed. Zero available repositories directs the user to browser-owned GitHub settings.

MCP header secrets use `--headers-file <json>` or `--headers-file -` for stdin. They are never accepted in ordinary command arguments, printed, or persisted locally.

JSON output is always one envelope: `{"schemaVersion":1,"ok":true,"data":{}}`. Errors use the same envelope with `ok: false`.

Exit codes: 2 usage, 3 authentication, 4 concealed/not found, 5 conflict/refusal, 6 network/upstream, 130 interruption.

On Sessions, `/new`, `/archive`, `/unarchive`, `/delete`, `/leave`, `/settings`, `/credentials`, `/account`, `/help`, `/logout`, `/sessions`, `/refresh`, `/exit`, and `/quit` appear as inline selectable suggestions. `/archive`, `/unarchive`, `/delete`, and `/leave` act on the currently selected row (same as pressing `a` for the full session-actions page). `/` never filters session rows. `/exit` and `/quit` both exit there.

Inside sessions, ordinary text queues work. Navigation commands are `/floor`, `/overview`, `/review`, `/settings`, and `/sessions`; `/repository` is absent from TUI while `openfloor repository …` remains scriptable. Direct background aliases include `/invite`, `/members`, `/agents`, `/assignments`, `/routing`, `/queue`, `/chat`, `/files`, `/runs`, `/conflicts`, `/skills`, `/mcp`, and `/review`. `/archive`, `/unarchive`, `/delete`, and `/leave` manage this session's lifecycle; delete and leave open a full-page confirmation, and delete discloses a live candidate branch before proceeding rather than retrying automatically. `/run` remains accepted but hidden for compatibility. `/exit` returns nested pages to Floor and Floor to Sessions; `/quit` always exits. Child output stays suppressed; bounded sanitized status appears inline.

Slash suggestions on both command bars match by prefix first, then by fuzzy subsequence, so a partial or scrambled fragment (e.g. `/dlt`) can still surface `/delete`.

`/credentials` opens masked write-only connection/disconnection for all server-supported API-key and subscription credential kinds. `/account` opens browser settings. Secrets are never ordinary slash-command arguments.
