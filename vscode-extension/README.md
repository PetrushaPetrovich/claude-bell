# Claude Bell

Chime in your VS Code window when Claude Code finishes its turn or waits for your permission. **Works over SSH, Remote and WSL**: the sound is produced in your VS Code window on your machine, so a remote server without speakers is not a problem.

Звук в вашем окне VS Code, когда Claude Code закончил ответ или ждёт разрешения. **Работает по SSH, в Remote и WSL**: звук рождается в окне VS Code на вашей машине, удалённый сервер без динамиков не помеха.

![Claude Bell panel in the VS Code bottom panel, next to Terminal](https://raw.githubusercontent.com/PetrushaPetrovich/claude-bell/main/vscode-extension/media/panel.png)

The **Claude Bell** tab lives in the bottom Panel next to Terminal: pick a sound card, preview it with ▶, choose your own file, set the volume. / Вкладка **Claude Bell** живёт в нижней панели рядом с Terminal: выберите карточку звука, послушайте по ▶, подключите свой файл, задайте громкость.

## Why Claude Bell / Почему это расширение

- **Rings over SSH, Remote and WSL.** Other bell extensions play sound through the operating system of the machine where the extension runs; on a remote Linux host that means silence. Claude Bell plays inside your VS Code window, wherever Claude Code runs.
- **Works on Linux.** The chimes are synthesized in the window, no system sound packages needed.
- **Self-contained.** Installs its own Claude Code hook; nothing else to install, no local server, no ports.
- **No telemetry, no auto-approve.** Nothing leaves your machine; your Claude Code permission settings are never touched.
- **Your own sound.** Pick any .wav / .mp3 / .ogg, or one of four built-in chimes, with a preview for each.

- **Звенит по SSH, в Remote и WSL.** Другие расширения играют звук через операционную систему той машины, где работает расширение; на удалённом Linux-сервере это тишина. Claude Bell играет внутри вашего окна VS Code, где бы ни работал Claude Code.
- **Работает на Linux.** Звуки синтезируются в окне, системные звуковые пакеты не нужны.
- **Самодостаточное.** Само ставит хук в Claude Code; ни локального сервера, ни портов, ничего ставить дополнительно.
- **Без телеметрии и автоодобрения.** Ничего не уходит с вашей машины; настройки разрешений Claude Code не трогаются.
- **Свой звук.** Любой .wav / .mp3 / .ogg или один из четырёх встроенных, каждый можно послушать заранее.

## Self-contained / Ничего больше не нужно

On first start the extension installs its own hook into Claude Code's user settings (`~/.claude/settings.json` on the machine where Claude Code runs): two plain shell one-liners on the **Stop** and **Notification** events that append a line to a signal file. No plugin, no Node, nothing else to install. New Claude Code conversations ring right away; in an already open one type `/hooks` once. Turn this off with `claudeBell.installHook: false`; uninstalling the extension removes the hook.

При первом запуске расширение само ставит свой хук в настройки Claude Code (`~/.claude/settings.json` на машине, где работает Claude Code): две shell-команды на события **Stop** и **Notification**, дописывающие строку в сигнальный файл. Ни плагина, ни Node, ничего ставить не нужно. Новые беседы Claude Code звенят сразу; в уже открытой один раз наберите `/hooks`. Отключить: `claudeBell.installHook: false`; удаление расширения убирает хук.

The optional `bell` Claude Code plugin from this repository does the same job for people who use Claude Code in a plain terminal without VS Code. Both installed together ring once.

Необязательный плагин `bell` для Claude Code из этого репозитория делает то же для тех, кто работает с Claude Code в обычном терминале без VS Code. Вместе они не дублируют звук.

## Install / Установка

Download `claude-bell-<version>.vsix` from the repository releases, then in VS Code: Extensions → `…` → **Install from VSIX**. For an SSH or WSL window VS Code installs it on the remote side automatically.

Скачайте `claude-bell-<version>.vsix` из релизов репозитория, затем в VS Code: Extensions → `…` → **Install from VSIX**. В окне SSH или WSL расширение само встанет на удалённую сторону.

## How it works / Как устроено

Claude Code runs the extension's hook when a turn ends (Stop) or when it waits for your permission or has been idle (Notification `permission_prompt` / `idle_prompt`). The hook appends a line to `~/.claude/.claude-bell-signal`. The extension watches that file. In a local window it plays the chosen sound through your operating system (with volume, no click needed): the four built-in chimes ship as WAV files rendered from the panel's own formulas, or your own file. In a remote window (SSH, WSL) the server has no speakers, so the small webview in the Panel plays the sound on your machine instead — webviews always render where you sit. While the extension is alive it keeps `~/.claude/.claude-bell-extension` fresh, and the optional `bell` plugin then skips its own OS player, so nothing rings twice.

Commands: **Claude Bell: Install hook into Claude Code** and **Claude Bell: Remove hook from Claude Code** redo or undo the hook by hand.

## Commands and settings / Команды и настройки

- `Claude Bell: Play test chime` — hear it now. / Послушать сейчас.
- `Claude Bell: Enable / Disable` — also the bell in the status bar. / Также колокольчик в строке состояния.
- `claudeBell.volume` (0–1), `claudeBell.enabled`, `claudeBell.signalFile`.

Keep the **Claude Bell** view open in the Panel (any Panel tab may be active). If the panel says sound is locked, click **Enable sound** once.

## Silent? / Тихо?

0. **Remote windows only: one click per window.** In a local window the ring plays through your operating system, no click needed. Over SSH or WSL the sound can only come from the panel, and browsers allow that after one click inside it: after VS Code starts, click anywhere in the Claude Bell panel once (its header shows **Enable sound** while locked). / **Только удалённые окна: один клик на окно.** В локальном окне звонок играет через операционную систему, кликать не нужно. По SSH или в WSL звук может идти только из панели, а браузер разрешает его после одного клика внутри неё: после запуска VS Code один раз кликните в панели Claude Bell (пока звук заблокирован, в шапке видна кнопка **Enable sound**).
1. Look at the bell in the status bar: a crossed bell means the extension is disabled — one click turns it back on. / Перечёркнутый колокольчик в строке состояния значит «выключено», один клик включает обратно.
2. View → Output → choose **Claude Bell** in the dropdown: every signal, ring and skip is logged there. / В Output выберите канал **Claude Bell**: там каждая строка сигнала и каждый звонок.
3. `~/.claude/.claude-bell-last` on the Claude Code machine shows the hook's last ring; `"code":"extension"` means the hook handed the sound to this extension. / Файл на машине Claude Code показывает последний вызов хука.

Держите вид **Claude Bell** открытым в нижней панели (активной может быть любая вкладка). Если панель пишет, что звук заблокирован, один раз нажмите **Enable sound**.
