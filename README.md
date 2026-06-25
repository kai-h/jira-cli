# jira-cli

A zero-dependency Jira Cloud CLI. Single Node.js script, no `npm install` required.

## Setup

Copy `jira.env.example` to `jira.env` (or `~/.config/jira/jira.env` for a global install) and fill in your credentials:

```
JIRA_API_TOKEN=your-api-token
JIRA_HOST=your-site.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_PROJECT=ABC
```

Get an API token at [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens).

## Usage

```
node jira.cjs <command> [args]

Commands:
  open       [--epic KEY] [--status name] [--priority name] [--assignee email]
  view       <KEY>
  create     "<summary>" [--epic KEY] [--priority name] [--issuetype name|id] [--desc "text"]
  close      <KEY> <comment>
  comment    <KEY> <comment>
  transition <KEY> <status-name>
  update     <KEY> [--priority p] [--assignee email] [--issuetype name]
  link       <KEY> <link-type> <TARGET-KEY>
```

## Config resolution

The script looks for config in this order:

1. `$JIRA_ENV_FILE` — explicit path override
2. `./jira.env` or `./.env` in the current working directory
3. `../.env` relative to the script (useful when the script lives in a subdirectory)
4. `~/.config/jira/jira.env` or `~/.jira.env`

## Examples

```sh
# List open tickets
node jira.cjs open

# Filter by epic and status
node jira.cjs open --epic PROJ-10 --status "In Progress"

# View a ticket with comments
node jira.cjs view PROJ-42

# Create a bug
node jira.cjs create "Login fails on Safari" --issuetype Bug --priority High

# Add a comment
node jira.cjs comment PROJ-42 "Reproduced on Safari 17.4"

# Move to a status
node jira.cjs transition PROJ-42 "In Progress"

# Close with a comment
node jira.cjs close PROJ-42 "Fixed in v1.2.3"

# Link two tickets
node jira.cjs link PROJ-42 "is blocked by" PROJ-38
```
