# Extraktor CLI

Read live web pages as Markdown and search the web from the terminal. Made for AI agents: each command prints Markdown that an agent can use directly. Run `extraktor --help` for every command and option.

```sh
npm install --global @extraktor/cli
extraktor login                      # or: export EXTRAKTOR_API_KEY=ext_...
extraktor extract https://example.com
```

Extraktor needs a Pro plan. Make API keys at <https://extraktor.app/developers>.

## Tasks

| Task | Command |
| --- | --- |
| Read a page, then answer or summarize | `extraktor extract <url>` |
| Get facts from a page | `extraktor extract <url> --find "<text>"` |
| Read or compare 2 to 5 pages | `extraktor extract <url> <url> ...` |
| Quote a page with a link to each quote | `extraktor extract <url> --excerpts --focus "<topic>"` |
| Save the complete page as Markdown | `extraktor extract <url> --save page.md` |
| Get contact details | `extraktor extract <url> --contacts` |
| Take a full-page screenshot | `extraktor extract <url> --screenshot` |
| Get the design system as DESIGN.md | `extraktor extract <url> --design-file DESIGN.md` |
| Audit the SEO of a page | `extraktor extract <url> --seo --keyword "<keyword>"` |
| Find how agents can use a site | `extraktor extract <url> --agent-access` |
| Find pages when you have no URL | `extraktor search "<query>"` |
| See what Google shows for a keyword | `extraktor search "<query>" --serp` |

A long page comes in parts of about 24,000 characters. Each part gives the command for the next part. The CLI keeps each page for 10 minutes, so `--find`, `--offset` and the same command again use no credit.

## Add the MCP server to your agents

```sh
npx -y @extraktor/cli mcp add
```

The command finds Claude Code, Codex, Cursor, VS Code, Gemini CLI and Windsurf on this computer and adds the server `https://extraktor.app/mcp` to each one. In a terminal, it first asks which agents to change. When an agent or a script runs it, it asks nothing. It keeps the other servers and settings, and a second run changes nothing. Each agent opens a sign-in page when it first uses Extraktor. The output shows the sign-in step for each agent.

Use `--agent <name>` to change only some agents, and `--json` for a JSON result. `extraktor mcp remove` removes the server. For the Claude app, open **Settings > Connectors > Add custom connector** and paste the server URL.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. |
| 1 | The page, the search or the server failed. Read the message. |
| 2 | The command or an option is not correct. The message tells the fix. |
| 3 | Sign-in, a plan or credits are necessary. |

Each error tells the next step. With `--json`, errors are JSON on standard output.

## Privacy

The CLI calls the Extraktor MCP server at `https://extraktor.app/mcp` (or `$EXTRAKTOR_URL`). It saves the API key in `~/.config/extraktor/credentials.json` and results for 10 minutes in `~/.cache/extraktor/results`. When a coding agent runs the CLI, the CLI sends the agent name (for example `claude-code`) in the `X-Extraktor-Agent` header, and no other data about the agent.

## License

[MIT](LICENSE)
