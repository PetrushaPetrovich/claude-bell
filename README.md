# claude-bell

Two ways to get a chime when Claude Code finishes its turn or waits for your permission:

- **Claude Bell VS Code extension** (`vscode-extension/`, `.vsix` in the releases): self-contained, installs its own Claude Code hook, rings inside your VS Code window — **works over SSH, Remote and WSL**, because the sound plays on your machine, not on the server. Your own sound file if you like, no telemetry. If you use VS Code, this is all you need.
- **`bell` Claude Code plugin** (below): for Claude Code in a plain terminal. Plays a system chime on the machine where Claude Code runs. No dependencies.

Два способа получить звонок, когда Claude Code закончил ответ или ждёт разрешения:

- **Расширение Claude Bell для VS Code** (`vscode-extension/`, файл `.vsix` в релизах): самодостаточное, само ставит хук в Claude Code, звенит в вашем окне VS Code — **работает по SSH, в Remote и WSL**, потому что звук рождается на вашей машине, а не на сервере. Свой звуковой файл по желанию, без телеметрии. Если вы работаете в VS Code, больше ничего не нужно.
- **Плагин `bell` для Claude Code** (ниже): для Claude Code в обычном терминале. Системный звук на машине, где работает Claude Code. Без зависимостей.

![Claude Bell panel in the VS Code bottom panel, next to Terminal](vscode-extension/media/panel.png)

## Install / Установка

```
claude plugin marketplace add PetrushaPetrovich/claude-bell
claude plugin install bell@claude-bell
```

Or in VS Code: Claude Code → Manage Plugins → Marketplaces → paste `PetrushaPetrovich/claude-bell` → Add, then install `bell` on the Plugins tab.

Или в VS Code: Claude Code → Manage Plugins → Marketplaces → вставить `PetrushaPetrovich/claude-bell` → Add, затем на вкладке Plugins установить `bell`.

New sessions ring right away. In an already open session type `/hooks` once so it reloads the hook list.

Новые сессии звенят сразу. В уже открытой сессии один раз наберите `/hooks`, чтобы список хуков перечитался.

## Over SSH or WSL / По SSH и в WSL

The hook runs where Claude Code runs, so a remote host has no speakers to play into. Install the **Claude Bell** VS Code extension from this repository's releases (`vscode-extension/`): it rings inside your VS Code window on your machine, and the hook then hands every ring to it instead of the OS player.

Хук работает там же, где Claude Code, и на удалённой машине ему негде играть. Поставьте расширение **Claude Bell** для VS Code из релизов этого репозитория (`vscode-extension/`): оно звенит в вашем окне VS Code на вашей машине, а хук передаёт ему каждый звонок вместо системного плеера.

## When it rings / Когда звенит

- **Stop** — Claude finished its turn and waits for you. / Claude закончил ответ и ждёт вас.
- **Notification** `permission_prompt` — Claude asks permission for an action. / Claude просит разрешение на действие.
- **Notification** `idle_prompt` — the session has been waiting for you for a while. / Сессия давно ждёт ответа.

At most one chime per 1.5 seconds.

## Settings / Настройки

All settings are environment variables, so they apply wherever Claude Code runs.

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_BELL_ENABLED` | on | `0` mutes the bell without uninstalling. |
| `CLAUDE_BELL_SOUND` | system chime | Path to your own `.wav` (Windows), `.aiff`/`.mp3` (macOS) or `.oga`/`.wav` (Linux). |
| `CLAUDE_BELL_NOTIFY` | `permission_prompt,idle_prompt` | Comma-separated Notification types that ring. |

Default sounds: `C:\Windows\Media\Windows Notify.wav`, `/System/Library/Sounds/Glass.aiff`, `/usr/share/sounds/freedesktop/stereo/complete.oga`.

Hear it now / Послушать сейчас:

```
node ~/.claude/plugins/cache/claude-bell/bell/1.1.1/scripts/bell.mjs --play
```

## Uninstall / Удаление

```
claude plugin uninstall bell@claude-bell
```

## How it works / Как устроено

Claude Code runs the plugin's hook on the `Stop` and `Notification` events. The hook spawns the OS's own player detached (PowerShell `System.Media.SoundPlayer`, `afplay`, `paplay`) and exits at once. It never writes to stdout, so the conversation never sees it.

Selftest: `node plugins/bell/scripts/bell.selftest.mjs`.

## License

MIT
