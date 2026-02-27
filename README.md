# Sidekick

Your AI-powered second brain inside Obsidian. Chat with agents, run tools, fire triggers, and transform text — all without leaving your vault.

Sidekick connects to GitHub Copilot to give you a fully configurable AI assistant panel with agents, skills, MCP tool servers, prompt templates, triggers, and an editor context menu.

> **Desktop only.** Requires a GitHub Copilot subscription and the Copilot CLI.

---

## Getting started

### 1. Check the GitHub Copilot CLI

Sidekick requires the GitHub Copilot CLI. If you have [GitHub Copilot in VS Code](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot), the CLI is already installed — you just need to find its path.

**Verify it's working** by running in a terminal:

```bash
copilot --version
```

If the command is not found, locate the binary using the paths below.

**Find the Copilot CLI path:**

| OS | Typical path |
|----|-------------|
| **Windows** | `%LOCALAPPDATA%\Programs\copilot-cli\copilot.exe` or check inside your VS Code extensions folder: `%USERPROFILE%\.vscode\extensions\github.copilot-*\copilot\dist\` |
| **Linux** | `~/.local/bin/copilot` or inside VS Code extensions: `~/.vscode/extensions/github.copilot-*/copilot/dist/` |
| **macOS** | `~/.local/bin/copilot` or inside VS Code extensions: `~/.vscode/extensions/github.copilot-*/copilot/dist/` |

**Log in** (if not already authenticated):

```bash
copilot auth login
```

Follow the browser-based authentication flow. Once logged in, confirm with:

```bash
copilot auth status
```

### 2. Install the plugin

Download `main.js`, `styles.css`, and `manifest.json` from the [latest release](https://github.com/vieiraae/obsidian-sidekick/releases/latest) and place them in your vault:

```
<YourVault>/.obsidian/plugins/sidekick/
```

Reload Obsidian. Enable **Sidekick** in **Settings → Community plugins**.

### 3. Configure the Copilot CLI

Open **Settings → Sidekick** and set the **Copilot location** to the full path of your `copilot` binary found in step 1 (leave blank if it's on your `PATH`). Click **Ping** to verify the connection.

### 4. Initialize the Sidekick folder

In the same settings tab, set a **Sidekick folder** name (default: `sidekick`) and click **Initialize**. This creates the folder structure with sample files:

```
sidekick/
  agents/        → Agent definitions (*.agent.md)
  skills/        → Skill definitions (subfolder with SKILL.md)
  tools/         → MCP server config (mcp.json)
  prompts/       → Prompt templates (*.prompt.md)
  triggers/      → Automated triggers (*.trigger.md)
```

### 5. Open Sidekick

Click the **brain** icon in the ribbon, or run the **Open Sidekick** command from the command palette.

---

## The chat panel

The Sidekick panel opens in the right sidebar. It includes:

- **Chat area** — Streaming AI conversation with full Markdown rendering.
- **Input area** — Type your message; press **Enter** to send, **Shift+Enter** for newlines.
- **Config toolbar** — Select agents, models, skills, tools, working directory, and toggle debug info.
- **Session sidebar** — Browse, search, rename, and switch between conversation sessions.

### Toolbar controls

| Control | Description |
|---------|-------------|
| **+** | Start a new conversation |
| **↻** | Reload all configuration files |
| **Agent dropdown** | Select an agent (auto-selects its preferred model, tools, and skills) |
| **Model dropdown** | Select an AI model |
| **Skills** (wand icon) | Toggle individual skills on/off |
| **Tools** (plug icon) | Toggle individual MCP tool servers on/off |
| **Working dir** (drive icon) | Set the working directory for file operations |
| **Debug** (bug icon) | Show tool calls, token usage, and timing metadata |

### Input actions

| Button | Description |
|--------|-------------|
| **Folder** | Select vault scope — limit which files and folders the AI can see |
| **Paperclip** | Attach files from your OS file system |
| **Clipboard** | Paste clipboard text as an attachment |

The **active note** is automatically attached to every message. The working directory follows the active note's parent folder.

---

## Agents

Agents are Markdown files in `sidekick/agents/` with the naming convention `*.agent.md`. Each agent defines a persona, preferred model, and which tools/skills to enable.

### Example: `grammar.agent.md`

```yaml
---
name: Grammar
description: The Grammar Assistant agent helps users improve their writing
tools:
  - github
skills:
  - ascii-art
model: Claude Sonnet 4.5
---

# Grammar Assistant agent Instructions

You are the **Grammar Assistant agent** — your primary task is to help users improve their writing.
```

### Frontmatter fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Display name shown in the agent dropdown |
| `description` | No | Short description of the agent's purpose |
| `model` | No | Preferred model name or ID (auto-selected when agent is chosen) |
| `tools` | No | YAML list of MCP tool server names to enable. Omit or leave empty for all. |
| `skills` | No | YAML list of skill names to enable. Omit or leave empty for all. |

The Markdown body below the frontmatter is the agent's **system instructions** — sent as context with every message.

When you select an agent, its `tools` and `skills` lists filter which servers and skills are active. You can still manually toggle them in the toolbar menus.

---

## Skills

Skills are subfolders inside `sidekick/skills/`, each containing a `SKILL.md` file.

### Example: `sidekick/skills/ascii-art/SKILL.md`

```yaml
---
name: ascii-art
description: Generates stylized ASCII art text using block characters
---

# ASCII Art Generator

This skill generates ASCII art representations of text using block-style Unicode characters.
```

Skills provide domain-specific instructions that extend the agent's capabilities. Toggle them on/off from the **wand** icon in the toolbar.

---

## Tools (MCP servers)

Tool servers are configured in `sidekick/tools/mcp.json`. Sidekick supports both local (stdio) and remote (HTTP/SSE) MCP servers.

### Example: `mcp.json`

```json
{
  "servers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    },
    "workiq": {
      "command": "npx",
      "args": ["-y", "@microsoft/workiq", "mcp"]
    },
    "my-local-tool": {
      "command": "node",
      "args": ["./my-tool/index.js"],
      "env": { "API_KEY": "..." }
    }
  }
}
```

The `github` server connects to GitHub Copilot's built-in MCP endpoint. The `workiq` server runs [Microsoft Work IQ](https://github.com/microsoft/work-iq-mcp) via NPX — it lets you query your Microsoft 365 data (emails, meetings, documents, Teams messages) using natural language. Work IQ requires Node.js 18+ and admin consent on your Microsoft 365 tenant (see the [admin guide](https://github.com/microsoft/work-iq-mcp/blob/main/ADMIN-INSTRUCTIONS.md) for details).

The format also accepts `"mcpServers"` as the top-level key. Toggle individual servers from the **plug** icon in the toolbar.

### Tool approval

In **Settings → Sidekick → Tools approval**, choose:

- **Allow** — Tool calls are auto-approved (default).
- **Ask** — A modal asks for approval before each tool invocation.

---

## Prompt templates

Prompt templates are Markdown files in `sidekick/prompts/` with the naming convention `*.prompt.md`. They provide reusable slash commands.

### Example: `en-to-pt.prompt.md`

```yaml
---
agent: Grammar
---
Translate the provided text from English to Portuguese.
```

### How to use

1. Type `/` in the chat input to open the prompt dropdown.
2. Start typing to filter prompts.
3. Use **Arrow keys** to navigate, **Enter** or **Tab** to select.
4. The prompt's content is prepended to your message. If the prompt specifies an `agent`, that agent is auto-selected.

### Frontmatter fields

| Field | Required | Description |
|-------|----------|-------------|
| `agent` | No | Auto-select this agent when the prompt is used |
| `description` | No | Shown in the prompt dropdown for context |

---

## Triggers

Triggers automate background tasks. They are Markdown files in `sidekick/triggers/` with the naming convention `*.trigger.md`.

### Example: `daily-planner.trigger.md`

```yaml
---
description: Daily planner
agent: Planner
triggers:
  - type: scheduler
    cron: "0 8 * * *"
  - type: onFileChange
    glob: "**/*.md"
---
Help me prepare my day, including asks on me, recommendations for clear actions to prepare, and suggestions on which items to prioritize over others.
```

### Trigger types

| Type | Field | Description |
|------|-------|-------------|
| `scheduler` | `cron` | Cron expression (minute, hour, day-of-month, month, day-of-week). Checked every 60 seconds. |
| `onFileChange` | `glob` | Glob pattern matching vault file paths. Fires when a matching file is created, modified, or renamed. |

### Frontmatter fields

| Field | Required | Description |
|-------|----------|-------------|
| `description` | No | Human-readable name for the trigger |
| `agent` | No | Agent to use when firing (its model and instructions apply) |
| `triggers` | Yes | YAML list of trigger entries (see above) |

Triggers run in **background sessions** — they appear in the session sidebar with a `[trigger]` tag. File-change triggers include the changed file path in the prompt context.

---

## Editor context menu

Select text in any note, right-click, and choose **Sidekick** to access quick actions:

| Action | Description |
|--------|-------------|
| **Fix grammar and spelling** | Corrects errors in the selected text |
| **Summarize** | Creates a concise summary |
| **Elaborate** | Adds more detail and depth |
| **Answer** | Responds to a question in the text |
| **Explain** | Explains in simple, clear terms |
| **Rewrite** | Improves clarity and readability |

The result **replaces the selected text** in-place.

---

## Sessions

Sidekick maintains a session sidebar on the right side of the panel:

- **Click** a session to switch to it (conversation history is restored).
- **Right-click** a session to rename or delete it.
- **Search** sessions using the filter box at the top.
- Sessions with a **green dot** are currently active (streaming or processing).
- Background sessions (from triggers) continue running even when you switch conversations.

Sessions are automatically named using the pattern `<Agent>: <first message>`. Trigger sessions include a `[trigger]` suffix.

---

## Settings reference

Open **Settings → Sidekick** to configure:

| Setting | Default | Description |
|---------|---------|-------------|
| **Copilot location** | *(empty)* | Path to the Copilot CLI binary. Leave blank if on `PATH`. |
| **Sidekick folder** | `sidekick` | Vault folder containing agents, skills, tools, prompts, and triggers. |
| **Tools approval** | Allow | Whether tool invocations require manual approval. |

Click **List** under the **Models** section to fetch and display all available models from the Copilot service.

---

## Folder structure overview

```
<YourVault>/
  sidekick/
    agents/
      grammar.agent.md          # Agent definition
    skills/
      ascii-art/
        SKILL.md                 # Skill definition
    tools/
      mcp.json                   # MCP server configuration
    prompts/
      en-to-pt.prompt.md         # Prompt template
    triggers/
      daily-planner.trigger.md   # Automated trigger
```

---

## Development

- Install dependencies: `npm install`
- Dev build (watch mode): `npm run dev`
- Production build: `npm run build`
- Lint: `npm run lint`
