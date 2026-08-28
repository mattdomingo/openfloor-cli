# TUI key map

- Home Up/Down: select session
- Home `Enter`: open session
- `/`: focus the Sessions command bar and show inline suggestions
- Home `n` or `/new`: open full-page session creation
- Home `/settings`, `/help`: open full pages
- Home `/logout`: remove openfloor's local Access session and exit
- Home `Esc`: clear command entry or return from Help/Settings to Sessions
- Floor ordinary text: add prompt to queue
- Floor `Tab`: enter or cycle Team chat, Agent floor, Prompt queue, and prompt focus
- Floor arrows: move between focused panes and rows
- Floor `Enter`: open selected message, agent, or prompt
- Floor `Esc`: close detail or return to prompt focus
- `/chat <message>`: send team chat
- `/floor`, `/overview`, `/review`, `/repository`, `/settings`: navigate
- `/sessions`: return to session selection
- `/commands` or `/help`: open full-page help
- `/run <CLI subcommand>`: execute command in background
- `/refresh`: refresh session
- `/sync`: retry paused local candidate synchronization
- `Ctrl+K`: focus the existing bottom command bar
- `?`: open the full Help page
- Home `q` or floor `/quit`: quit

Minimum functional width is 60 columns. Widths below 100 stack session panes; wider terminals show all three columns. `Ctrl+C` exits local UI or a watcher and never cancels a remote run.

New-session flow uses Enter to advance task, optional goal, candidate name, repository, and confirmation. Repository selection uses Up/Down and `s` search. Esc returns one step or opens Sessions from the first step. Submission happens once. Local workspace confirmation is a full page, requires a clean checkout, and discloses exact candidate checkout and receive-only fast-forward behavior. Teammates receive the same confirmation before an existing matching session binds locally. No navigation action opens a popup.
