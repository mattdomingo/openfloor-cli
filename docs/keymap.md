# TUI key map

- Home Up/Down: select session
- Home `Enter`: open session
- `/`: focus the Sessions command bar and show inline suggestions
- Home `n` or `/new`: open full-page session creation
- Home `a`: open the session-actions page for the selected session (archive/unarchive, delete or leave, cancel)
- Home `/archive`, `/unarchive`, `/delete`, `/leave`: same session-lifecycle actions from the command bar
- Home `/settings`, `/help`: open full pages
- Home `/logout`: remove openfloor's local Access session and exit
- Home `Esc`: clear command entry or return from Help/Settings to Sessions
- Floor ordinary text: add prompt to queue
- Floor `Tab` / `Shift+Tab`: cycle forward/backward through Team chat, Live teammate prompts, Agent floor, Prompt queue, and prompt focus
- Floor arrows: move between focused panes and rows; Up/Down scroll a pane's cursor over its full list, not just the visible slice — a dimmed count of items above/below appears when the pane is scrolled
- Floor `Enter`: open selected message, agent, or prompt
- Floor `Esc`: close detail or return to prompt focus
- Loading `Esc`: stop the in-flight read and leave the loading page; session loading returns to Sessions
- `/chat <message>`: send team chat
- `/floor`, `/overview`, `/review`, `/settings`: navigate
- `/sessions`: return to session selection
- `/archive`, `/unarchive`, `/delete`, `/leave`: manage this session's lifecycle (delete/leave open a full-page confirmation; delete discloses a live candidate branch before proceeding)
- `/commands` or `/help`: open full-page help
- `/invite`, `/agents`, `/skills`, and other command groups: execute directly in background
- `/run <CLI subcommand>`: hidden compatibility form
- `/credentials`: safely connect/disconnect AI credentials
- `/account`: open browser-owned account settings
- `/exit`: contextual Back; nested page to Floor, Floor to Sessions, Sessions exits
- `/refresh`: refresh session
- `/sync`: retry paused local candidate synchronization
- `/logout`: remove openfloor's local Access session and exit from any command bar
- `Ctrl+K`: focus the existing bottom command bar (also returns floor focus to the prompt when a pane is active)
- Command Up/Down: select a suggestion when suggestions are showing; otherwise recall older/newer entries from this bar's in-memory command history (never persisted). Enter autocompletes a partial selection, then executes exact command
- Suggestions match by prefix first, then by fuzzy subsequence (e.g. `/dlt` can still surface `/delete`)
- Editable fields (prompt, command bars, forms): `Ctrl+A`/`Ctrl+E` jump to line start/end, `Ctrl+U` kills to line start, `Ctrl+W` and `Option+Backspace` delete the previous word. `Ctrl+K` is reserved for focusing the command bar/prompt, not kill-to-end.
- `?`: open the full Help page
- `Ctrl+C` twice within 2 seconds, or `Ctrl+D` on an empty prompt: exit. A single `Ctrl+C` arms and shows a warning (naming any mutation still in flight) without exiting.

Minimum functional width is 60 columns. Widths below 100 stack session panes; wider terminals show chat/drafts, agents, and queue columns. Active queue work renders before terminal results. `Ctrl+C`/`Ctrl+D` exit local UI or watcher and never cancel a remote run.

New-session flow uses Enter to advance task, optional goal, candidate name, repository, and confirmation. Repository selection uses Up/Down and `s` search. Esc returns one step or opens Sessions from the first step. Submission happens once. Local workspace confirmation is a full page, requires a clean checkout, and discloses exact candidate checkout and receive-only fast-forward behavior. Teammates receive the same confirmation before an existing matching session binds locally. No navigation action opens a popup.
