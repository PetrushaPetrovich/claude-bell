# Claude Bell (VS Code extension)

Chime in your VS Code window when Claude Code finishes its turn or waits for your permission. The sound is produced **on your machine**, so it works when Claude Code runs over SSH or in WSL.

Звук в вашем окне VS Code, когда Claude Code закончил ответ или ждёт разрешения. Звук рождается **на вашей машине**, поэтому работает при подключении по SSH и в WSL.

## Requires / Нужно

The `bell` Claude Code plugin on the machine where Claude Code runs (the hook writes the signal this extension listens to):

```
claude plugin marketplace add PetrushaPetrovich/claude-bell
claude plugin install bell@claude-bell
```

## Install / Установка

Download `claude-bell-<version>.vsix` from the repository releases, then in VS Code: Extensions → `…` → **Install from VSIX**. For an SSH or WSL window VS Code installs it on the remote side automatically.

Скачайте `claude-bell-<version>.vsix` из релизов репозитория, затем в VS Code: Extensions → `…` → **Install from VSIX**. В окне SSH или WSL расширение само встанет на удалённую сторону.

## How it works / Как устроено

The plugin hook appends a line to `~/.claude/.claude-bell-signal` on every Stop / permission / idle event. The extension polls that file and tells a small webview in the Panel to play a two-tone chime with Web Audio. Webviews always render on your machine, which is why the sound reaches you over SSH. While the extension is alive it keeps `~/.claude/.claude-bell-extension` fresh, and the plugin hook then skips its own OS player, so a local session rings once.

## Commands and settings / Команды и настройки

- `Claude Bell: Play test chime` — hear it now. / Послушать сейчас.
- `Claude Bell: Enable / Disable` — also the bell in the status bar. / Также колокольчик в строке состояния.
- `claudeBell.volume` (0–1), `claudeBell.enabled`, `claudeBell.signalFile`.

Keep the **Claude Bell** view open in the Panel (any Panel tab may be active). If the panel says sound is locked, click **Enable sound** once.

Держите вид **Claude Bell** открытым в нижней панели (активной может быть любая вкладка). Если панель пишет, что звук заблокирован, один раз нажмите **Enable sound**.
