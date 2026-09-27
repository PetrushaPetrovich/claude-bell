# Claude Bell

Chime in your VS Code window when Claude Code finishes its turn or waits for your permission. **Works over SSH, Remote and WSL**: the sound is produced in your VS Code window on your machine, so a remote server without speakers is not a problem.

Звук в вашем окне VS Code, когда Claude Code закончил ответ или ждёт разрешения. **Работает по SSH, в Remote и WSL**: звук рождается в окне VS Code на вашей машине, удалённый сервер без динамиков не помеха.

![Claude Bell panel in the VS Code bottom panel, next to Terminal](https://raw.githubusercontent.com/PetrushaPetrovich/claude-bell/main/vscode-extension/media/panel.png)

The **Claude Bell** tab lives in the bottom Panel next to Terminal: pick a sound card, preview it with ▶, add your own with **+**, set the volume. / Вкладка **Claude Bell** живёт в нижней панели рядом с Terminal: выберите карточку звука, послушайте по ▶, добавьте свои через **+**, задайте громкость.

## Why Claude Bell / Почему это расширение

- **Rings over SSH, Remote and WSL.** Other bell extensions play sound through the operating system of the machine where the extension runs; on a remote Linux host that means silence. Claude Bell plays inside your VS Code window, wherever Claude Code runs.
- **Works on Linux.** The chimes are synthesized in the window, no system sound packages needed.
- **Self-contained.** Installs its own Claude Code hook; nothing else to install, no local server, no ports.
- **No telemetry, no auto-approve.** Nothing leaves your machine; your Claude Code permission settings are never touched.
- **Your own sounds, as a library.** Every audio file in your sounds folder (`~/.claude/claude-bell/sounds`, or `claudeBell.soundsFolder`) is a card in the panel. **+** picks files and converts them once into normalized mono WAV (silence trimmed, volume leveled) so they play through the OS player on every system without a click; files you drop into the folder by hand show up too; **×** on a card deletes the file after a confirm.

- **Звенит по SSH, в Remote и WSL.** Другие расширения играют звук через операционную систему той машины, где работает расширение; на удалённом Linux-сервере это тишина. Claude Bell играет внутри вашего окна VS Code, где бы ни работал Claude Code.
- **Работает на Linux.** Звуки синтезируются в окне, системные звуковые пакеты не нужны.
- **Самодостаточное.** Само ставит хук в Claude Code; ни локального сервера, ни портов, ничего ставить дополнительно.
- **Без телеметрии и автоодобрения.** Ничего не уходит с вашей машины; настройки разрешений Claude Code не трогаются.
- **Свои звуки как библиотека.** Каждый аудиофайл в папке звуков (`~/.claude/claude-bell/sounds` или `claudeBell.soundsFolder`) становится плиткой в панели. **+** выбирает файлы и один раз перекодирует их в выровненный моно WAV (тишина обрезана, громкость нормализована), чтобы они играли системным плеером на любой системе без клика; файлы, положенные в папку вручную, тоже появляются; **×** на плитке удаляет файл после подтверждения.

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
- `Claude Bell: Add a sound file to your sounds` — the same as **+** in the panel. / То же, что **+** в панели.
- `Claude Bell: Enable / Disable` — also the bell in the status bar. / Также колокольчик в строке состояния.
- `claudeBell.volume` (0–1), `claudeBell.enabled`, `claudeBell.soundsFolder`, `claudeBell.signalFile`.

Keep the **Claude Bell** view open in the Panel (any Panel tab may be active). If the panel says sound is locked, click **Enable sound** once.

## Remote windows / Удалённые окна

Over SSH, in WSL or a dev container the extension runs on the remote host, so only the four built-in sounds are offered there and the panel says so; your own sound library stays on your local machine. A library sound chosen locally is replaced by the desk bell in a remote window automatically. / По SSH, в WSL или dev-контейнере расширение работает на удалённой машине, поэтому там доступны только четыре встроенных звука, и панель об этом сообщает; ваша библиотека остаётся на локальной машине. Выбранный локально свой звук в удалённом окне автоматически заменяется на Desk bell.

If a play fails (a missing or unreadable file, a broken player), the ring is repeated once with the built-in desk bell. / Если воспроизведение не удалось (файл пропал или не читается, плеер сломан), звонок один раз повторяется встроенным Desk bell.

## Building / Сборка

`npm run package` renders the built-in sounds and runs the selftest before packaging. Two built-in sounds (desk bell, desk bell ×2) are licensed recordings kept in `media/sounds-licensed/`, a folder git ignores: they ship inside the package but are not redistributed as files. Without them the build falls back to synthesized versions of the same bells. / `npm run package` собирает встроенные звуки и прогоняет селфтест перед упаковкой. Два встроенных звука (Desk bell и Desk bell ×2) — лицензионные записи в папке `media/sounds-licensed/`, которую git игнорирует: они входят в пакет, но не распространяются как файлы. Без них сборка использует синтезированные версии тех же колокольчиков.

## Silent? / Тихо?

0. **Remote windows only: one click per window.** In a local window the ring plays through your operating system, no click needed. Over SSH or WSL the sound can only come from the panel, and browsers allow that after one click inside it: after VS Code starts, click anywhere in the Claude Bell panel once (its header shows **Enable sound** while locked). / **Только удалённые окна: один клик на окно.** В локальном окне звонок играет через операционную систему, кликать не нужно. По SSH или в WSL звук может идти только из панели, а браузер разрешает его после одного клика внутри неё: после запуска VS Code один раз кликните в панели Claude Bell (пока звук заблокирован, в шапке видна кнопка **Enable sound**).
1. Look at the bell in the status bar: a crossed bell means the extension is disabled — one click turns it back on. / Перечёркнутый колокольчик в строке состояния значит «выключено», один клик включает обратно.
2. View → Output → choose **Claude Bell** in the dropdown: every signal, ring and skip is logged there. / В Output выберите канал **Claude Bell**: там каждая строка сигнала и каждый звонок.
3. `~/.claude/.claude-bell-last` on the Claude Code machine shows the hook's last ring; `"code":"extension"` means the hook handed the sound to this extension. / Файл на машине Claude Code показывает последний вызов хука.

Держите вид **Claude Bell** открытым в нижней панели (активной может быть любая вкладка). Если панель пишет, что звук заблокирован, один раз нажмите **Enable sound**.
