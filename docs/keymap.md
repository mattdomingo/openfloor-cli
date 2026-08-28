# TUI key map

- Up/Down: move selected row
- Left/Right or `Tab` / `Shift+Tab`: previous/next session tab
- `Enter`: open selected row, file, or context action; submit in forms
- `Esc`: close overlay or return home
- `/`: filter home sessions
- `n`: create session or queue prompt, depending on view
- `c`: compose team chat
- `e`: open context command
- `r`: refresh
- `Ctrl+K`: command palette
- `?`: help
- `q`: quit outside editors

Minimum functional width is 60 columns. Widths below 120 use one-pane session navigation; wider terminals show navigation and detail together. `Ctrl+C` exits local UI or a watcher and never cancels a remote run.

New-session flow uses Enter to advance task, optional goal, candidate name, repository, and confirmation. Repository selection uses Up/Down and `/` search. Esc returns one step or closes from the first step. Submission happens once.
