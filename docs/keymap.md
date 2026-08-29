# TUI key map

- Home Up/Down: select session
- Home `Enter`: open session
- `/`: focus the Sessions command bar and show inline suggestions
- Home `n` or `/new`: open full-page session creation
- Home `/settings`, `/help`: open full pages
- Home `/logout`: remove openfloor's local Access session and exit
- Home `Esc`: clear command entry or return from Help/Settings to Sessions
- Floor ordinary text: add prompt to queue
- Floor `Tab`: cycle Team chat, Live teammate prompts, Agent floor, Prompt queue, and prompt focus
- Floor arrows: move between focused panes and rows
- Floor `Enter`: open selected message, agent, or prompt
- Floor `Esc`: close detail or return to prompt focus
- Loading `Esc`: stop the in-flight read and leave the loading page; session loading returns to Sessions
- `/chat <message>`: send team chat
- `/floor`, `/overview`, `/review`, `/settings`: navigate
- `/sessions`: return to session selection
- `/commands` or `/help`: open full-page help
- `/invite`, `/agents`, `/skills`, and other command groups: execute directly in background
- `/run <CLI subcommand>`: hidden compatibility form
- `/credentials`: safely connect/disconnect AI credentials
- `/account`: open browser-owned account settings
- `/exit`: contextual Back; nested page to Floor, Floor to Sessions, Sessions exits
- `/refresh`: refresh session
- `/sync`: retry paused local candidate synchronization
- `/logout`: remove openfloor's local Access session and exit from any command bar
- `Ctrl+K`: focus the existing bottom command bar
- Command Up/Down: select suggestion; Enter autocompletes a partial selection, then executes exact command
- `Option+Backspace`: delete previous word in editable fields
- `?`: open the full Help page
- Home `q` or floor `/quit`: quit

Minimum functional width is 60 columns. Widths below 100 stack session panes; wider terminals show chat/drafts, agents, and queue columns. Active queue work renders before terminal results. `Ctrl+C` exits local UI or watcher and never cancels remote run.

New-session flow uses Enter to advance task, optional goal, candidate name, repository, and confirmation. Repository selection uses Up/Down and `s` search. Esc returns one step or opens Sessions from the first step. Submission happens once. Local workspace confirmation is a full page, requires a clean checkout, and discloses exact candidate checkout and receive-only fast-forward behavior. Teammates receive the same confirmation before an existing matching session binds locally. No navigation action opens a popup.
