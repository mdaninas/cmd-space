# CMD Space

**CMD Space** is a local terminal workspace that runs real **Windows Command Prompt (`cmd.exe`) sessions** in your browser. Manage multiple sessions, search terminal output, and customize your workspace.

The frontend uses React, TypeScript, and xterm.js. The Node.js backend uses WebSocket and node-pty with Windows ConPTY. Commands run directly on your computer.

## Quick start

1. Make sure you have Windows 10/11 and **Node.js 22.12 or later**.
2. Open the project folder and double-click **`start-terminal.cmd`**.
3. Wait for dependency installation, if needed, and the build. Your browser opens **http://localhost:3000** once the server is ready.
4. Use the terminal in your browser. The server keeps running in the background after the launcher window closes.
5. Double-click **`stop-terminal.cmd`** to stop the application.

Running start again opens the existing server without creating another instance. Closing the browser does not stop the server. Stop ends all terminal sessions and their child processes, so finish any running work first.

| File | Purpose |
| --- | --- |
| `start-terminal.cmd` | Install dependencies if needed, build, start in the background, and open the browser. |
| `stop-terminal.cmd` | Stop the server started by the launcher and its terminal sessions. |
| `terminal-control.ps1` | Process manager used by both launchers. |
| `server.stdout.log` | Server output from the launcher. |
| `server.stderr.log` | Server errors from the launcher. |

The launcher stores the server's process identity in `.terminal-process.json`. Keep this file while the server is running so the stop script can identify its process.

## Manual setup

Requirements: **Windows 10/11 with ConPTY** and **Node.js 22.12+**. The native node-pty dependency includes Windows x64/ARM64 binaries. If installation needs to build a binary, you will need Python, Visual Studio Build Tools with the Desktop development with C++ workload, and the Windows SDK.

Run these commands from the project folder:

```powershell
npm ci
npm run build
npm start
```

Open **http://localhost:3000**. Keep the server running while using the terminal. For development with hot reload:

```powershell
npm run dev
```

For a manually started server, keep its terminal window open and press **Ctrl+C** in that window to stop it. `stop-terminal.cmd` only manages servers started by the launcher. Stop any manual server before using the launcher on the same port.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Local HTTP port, from 1 to 65535. |
| `TERMINAL_CWD` | Project folder | Starting directory for CMD sessions. |

Set an optional port and starting directory in PowerShell:

```powershell
$env:PORT = '3001'
$env:TERMINAL_CWD = 'C:\Users'
npm start
```

You can use the same settings with the launcher from the project folder:

```powershell
$env:PORT = '3001'
$env:TERMINAL_CWD = 'C:\Users'
.\start-terminal.cmd
```

To apply new settings to an already running launcher server, stop it first, then start it again. These environment variables apply to the current PowerShell window and processes launched from it.

To start without opening the browser automatically:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\terminal-control.ps1 -Action start -NoBrowser
```

## Features

- Real CMD commands, file and folder operations, `cd`, drive switching, environment variables, pipes, redirection, executables, and batch files.
- Interactive input such as `set /p` and the Node REPL, Ctrl+C, command history with the arrow keys, path completion with Tab, ANSI output, and terminal resizing.
- Up to 12 independent sessions, sidebar search, shortcuts to session starting folders, and session renaming.
- Sessions, processes, environment, and terminal output survive a browser refresh. Reconnecting restores the screen from the server's terminal buffer, including colors and cursor position.
- Output search with highlighting and match counts, copy and paste, starting-directory path copying, `.txt` buffer export, and scrollback clearing.
- Focus mode with `Ctrl+Shift+Enter`, a collapsible sidebar, and session-tab navigation with the arrow keys, Home, and End.
- A command palette with `Ctrl+Shift+P` to find sessions, create terminals, rename sessions, export output, and open settings.
- Font sizes from 10 to 24 px, Graphite and Midnight themes, and cursor preferences saved in the browser.
- Live previews of appearance settings, saved sidebar preferences, and a visible session limit before creating a terminal.
- Responsive layouts, touch controls for Esc, Tab, Ctrl+C, and arrow keys, keyboard navigation, accessible labels, and terminal screen-reader mode.

## AI agent automation through Chrome

CMD Space can serve as a browser-accessible terminal for AI agents. With a compatible Chrome extension, browser-control plugin, or computer-use tool, an agent can interact with the terminal page: focus a session, type commands, press Enter, inspect visible output, and continue based on the result. The commands execute in a real local CMD session, giving the agent a workflow similar to operating a terminal directly.

For example, OpenAI Codex/GPT-based agents and Claude-based agents can use this approach **when their environment provides local browser control and permits interaction with CMD Space**. Browser-control options are documented in [OpenAI's browser documentation](https://learn.chatgpt.com/docs/browser?surface=app) and [Claude Code's Chrome integration documentation](https://code.claude.com/docs/en/chrome). Availability and permissions depend on the agent product and setup.

### Example workflow

1. Start CMD Space with `start-terminal.cmd`.
2. Connect your agent's Chrome extension or browser-control tool to the local browser and allow access to the CMD Space page.
3. Open `http://localhost:3000` and select or create a terminal session.
4. Give the agent a specific task and ask it to enter commands through the terminal, wait for output, and report the result.
5. Keep the server running during the task. Use `stop-terminal.cmd` when finished.

Example prompt:

```text
Open http://localhost:3000 using your browser-control tool.
Select a CMD Space terminal session and focus its terminal input.
Run `cd` and `dir`, wait for the output, and summarize the current
directory and its contents. Use this browser terminal for the commands.
```

The controlled browser must run on the same Windows computer as CMD Space, or have an explicitly configured connection to it. A browser running in a separate cloud environment cannot reach your computer's localhost by default. The agent's tool must support keyboard input and reading the rendered terminal; compatibility with individual extensions has not been verified.

CMD Space provides the terminal interface; the external agent supplies the automation. No AI model, API key, dedicated agent plugin, or MCP integration is bundled with this project. Commands entered by an agent run with the same account permissions as commands you type yourself.

## Session behavior and limitations

- Commands run with **the permissions of the account running the server**. To run administrator commands, start the server from an elevated Windows terminal.
- The server listens only on **127.0.0.1** and checks Host, Origin, and a custom header for requests that modify sessions. It is intended for local, single-user access.
- Closing a browser tab does not stop its session. Closing a session with the × button terminates CMD and processes in its console. Sessions without a browser connection are removed after 24 hours. Stopping or restarting the server ends all sessions; running processes are not persisted to disk.
- Each session supports one active browser tab. Opening the same session in another tab transfers the connection; the previous tab shows a button to take control again.
- Scrollback is limited to 5,000 lines per session. Exports contain the remaining buffer, rather than unlimited history. Clearing scrollback affects the browser display; use `cls` to clear the CMD screen.
- The toolbar shows the **session's starting directory**. The actual current directory appears in the CMD prompt and can be checked with `cd`.
- Ctrl+C copies selected text; without a selection, it sends Ctrl+C to the process. Ctrl+V pastes text. Clipboard permissions depend on the browser. Some shortcuts may be intercepted by the browser; actions are also available through the interface.
- Console applications run through ConPTY. GUI applications open Windows desktop windows on the server computer. CMD window features, UAC prompts, and older console applications that are incompatible with ConPTY cannot be fully reproduced in the browser.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Node.js is missing or too old | Install Node.js 22.12+, reopen the terminal or File Explorer, and try again. Check the version with `node --version`. |
| Port 3000 is already in use | Stop a manual server with Ctrl+C in its original terminal. For a launcher server, use the stop script. You can also set a different `PORT`. |
| Dependency installation fails | Check your internet connection and launcher output. If node-pty needs compilation, install Python, Visual Studio Build Tools with Desktop development with C++, and the Windows SDK. |
| Build fails | Read the error in the launcher. A new server is not started if the build fails. |
| Server fails to start or the browser does not open | Check `server.stderr.log` and `server.stdout.log`. Open the address printed by the launcher manually; for the default port, use http://localhost:3000 or http://127.0.0.1:3000. |
| Stop reports no active server | The script only recognizes servers started by the launcher. Stop manual servers in their original terminals. |
| Code changes are not visible | In normal mode, stop and start again to rebuild, then refresh the browser. For development, use `npm run dev`. |

## Build and testing

```powershell
npm run build
npm test
```

Integration tests run real CMD sessions and cover persistent environment and directories, pipes, interactive input, Ctrl+C, resizing and long-prompt recovery, reconnecting, session isolation, viewer transfer, output flow control, input validation, rejection of foreign origins and hosts, and child-process termination. Tests start their server on a random port and clean up their own processes.

## Project structure

- `index.html`: HTML entry point and CMD Space browser-tab title.
- `start-terminal.cmd` / `stop-terminal.cmd`: Windows launchers for starting and stopping the application.
- `terminal-control.ps1`: Build execution, process identity tracking, server readiness checks, and browser opening.
- `package.json`: Dependencies and npm scripts.
- `server/index.js`: HTTP/WebSocket server, session lifecycle, headless terminal buffer, and flow control.
- `server/conpty-cleanup.js`: Isolated workaround for leftover worker resources in node-pty **1.1.0**. The version is pinned because the workaround uses internal library APIs; review it when upgrading.
- `src/terminal.ts`: Browser terminal, reconnecting, input, resizing, clipboard, and export.
- `src/App.tsx`: Interface, sessions, dialogs, and settings.
- `src/CommandPalette.tsx`: Action and session search with keyboard navigation.
- `src/styles.css`: Desktop and mobile styling.
- `tests/terminal.test.js`: Windows integration tests.

## References

- [node-pty](https://github.com/microsoft/node-pty)
- [xterm.js](https://xtermjs.org/)
- [xterm.js flow control](https://xtermjs.org/docs/guides/flowcontrol/)
