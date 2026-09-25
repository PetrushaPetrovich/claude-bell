# claude-bell

A Claude Code plugin that plays a short system chime when Claude finishes its turn or waits for your permission. Works in the terminal and in the VS Code extension, on Windows, macOS and Linux. No dependencies.

Плагин для Claude Code: короткий системный звук, когда Claude закончил ответ или ждёт вашего разрешения. Работает в терминале и в расширении VS Code, на Windows, macOS и Linux. Без зависимостей.

## Install / Установка

```
claude plugin marketplace add PetrushaPetrovich/claude-bell
claude plugin install bell@claude-bell
```

Or in VS Code: Claude Code → Manage Plugins → Marketplaces → paste `PetrushaPetrovich/claude-bell` → Add, then install `bell` on the Plugins tab.

Или в VS Code: Claude Code → Manage Plugins → Marketplaces → вставить `PetrushaPetrovich/claude-bell` → Add, затем на вкладке Plugins установить `bell`.

New sessions ring right away. In an already open session type `/hooks` once so it reloads the hook list.

Новые сессии звенят сразу. В уже открытой сессии один раз наберите `/hooks`, чтобы список хуков перечитался.

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
node ~/.claude/plugins/cache/claude-bell/bell/1.0.1/scripts/bell.mjs --play
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
