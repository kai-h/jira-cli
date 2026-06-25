#!/usr/bin/env node
/**
 * Jira CLI — a zero-dependency Jira Cloud CLI.
 * Usage: node jira.cjs <command> [args]
 *
 * Commands:
 *   open    [--epic KEY] [--status name] [--priority name] [--assignee email]
 *   view    <KEY>
 *   create  "<summary>" [--epic KEY] [--priority name] [--issuetype name] [--desc "text"]
 *   close   <KEY> <comment>
 *   comment <KEY> <comment>
 *   transition <KEY> <status-name>
 *   update  <KEY> [--priority p] [--assignee email] [--issuetype name]
 *   link    <KEY> <link-type> <TARGET-KEY>   (e.g. "duplicates", "is blocked by")
 */

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

// Load env from the first .env-style file found, if JIRA_API_TOKEN not already set.
// Search order lets the script run standalone from anywhere:
//   1. $JIRA_ENV_FILE (explicit override)
//   2. ./jira.env or ./.env in the current working directory
//   3. ../.env relative to this script (repo-root fallback when script is in a subdirectory)
//   4. ~/.config/jira/jira.env or ~/.jira.env (global per-user config)
if (!process.env.JIRA_API_TOKEN) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [
    process.env.JIRA_ENV_FILE,
    path.resolve(process.cwd(), 'jira.env'),
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '../.env'),
    home && path.join(home, '.config', 'jira', 'jira.env'),
    home && path.join(home, '.jira.env'),
  ].filter(Boolean);

  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
      }
    }
    if (process.env.JIRA_API_TOKEN) break;
  }
}

// Per-instance config — supplied entirely via env (see jira.env.example).
// No hardcoded defaults, so the script is portable to any Jira Cloud site.
const JIRA_HOST = process.env.JIRA_HOST;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_PROJECT = process.env.JIRA_PROJECT;
// Numeric transition ID for "Done" (optional). When unset, the `close` command
// resolves a transition by destination status category instead.

const auth = Buffer.from(`${JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: JIRA_HOST,
      path,
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    let data = '';
    const req = https.request(options, (res) => {
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        const parsed = data ? JSON.parse(data) : null;
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`));
        } else {
          resolve(parsed);
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Convert plain text to ADF, preserving line structure (ADF text nodes ignore
// raw "\n"). Blank-line-separated blocks become paragraphs; single newlines
// become hard breaks; blocks whose lines all start with "- " or "* " render as
// a bullet list.
function textToADF(text) {
  const content = [];
  for (const block of String(text).split(/\n[ \t]*\n/)) {
    const lines = block.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;

    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      content.push({
        type: 'bulletList',
        content: lines.map((l) => ({
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: l.replace(/^\s*[-*]\s+/, '') }] }],
        })),
      });
    } else {
      const para = [];
      lines.forEach((line, i) => {
        if (i > 0) para.push({ type: 'hardBreak' });
        para.push({ type: 'text', text: line });
      });
      content.push({ type: 'paragraph', content: para });
    }
  }
  if (content.length === 0) {
    content.push({ type: 'paragraph', content: [{ type: 'text', text: String(text) }] });
  }
  return content;
}

function makeComment(text) {
  return {
    body: {
      type: 'doc',
      version: 1,
      content: textToADF(text),
    },
  };
}

const PRIORITY_ICONS = { Highest: '🔴', High: '🟠', Medium: '🟡', Low: '🟢', Lowest: '⚪' };
const STATUS_ICONS = { 'To Do': '○', 'In Progress': '◑', 'On Hold': '⏸', Done: '✓' };

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdOpen(args) {
  const flags = parseFlags(args);
  const conditions = [`project=${JIRA_PROJECT}`, 'statusCategory!=Done'];
  if (flags.epic) conditions.push(`"Epic Link"=${flags.epic} OR parent=${flags.epic}`);
  if (flags.status) conditions.push(`status="${flags.status}"`);
  if (flags.priority) conditions.push(`priority="${flags.priority}"`);
  if (flags.assignee) conditions.push(`assignee="${flags.assignee}"`);

  const jql = conditions.join(' AND ') + ' ORDER BY priority ASC, created ASC';
  const res = await api('POST', '/rest/api/3/search/jql', {
    jql,
    maxResults: 100,
    fields: ['summary', 'status', 'priority', 'issuetype', 'assignee', 'parent', 'labels'],
  });

  const issues = res.issues || [];
  if (!issues.length) { console.log('No open tickets found.'); return; }

  let lastEpic = null;
  for (const i of issues) {
    const epic = i.fields.parent?.key || 'No Epic';
    const epicName = i.fields.parent?.fields?.summary || '';
    if (epic !== lastEpic) {
      console.log(`\n── ${epic}${epicName ? ': ' + epicName : ''} ──`);
      lastEpic = epic;
    }
    const pri = i.fields.priority?.name || '?';
    const status = i.fields.status?.name || '?';
    const assignee = i.fields.assignee?.displayName || '—';
    const icon = PRIORITY_ICONS[pri] || '?';
    const sIcon = STATUS_ICONS[status] || status;
    console.log(`  ${icon} ${i.key.padEnd(12)} [${sIcon} ${status.padEnd(12)}] ${i.fields.summary}`);
  }
  console.log(`\nTotal: ${issues.length}`);
}

async function cmdView(args) {
  const key = args[0];
  if (!key) throw new Error('Usage: jira view <KEY>');

  const i = await api('GET', `/rest/api/3/issue/${key}?fields=summary,status,priority,assignee,description,comment,parent,labels,issuetype,created,updated`);
  const f = i.fields;

  console.log(`\n${i.key} — ${f.summary}`);
  console.log(`Status:   ${f.status?.name}  |  Priority: ${f.priority?.name}  |  Type: ${f.issuetype?.name}  |  Assignee: ${f.assignee?.displayName || 'Unassigned'}`);
  if (f.parent) console.log(`Epic:     ${f.parent.key} — ${f.parent.fields?.summary}`);
  if (f.labels?.length) console.log(`Labels:   ${f.labels.join(', ')}`);
  console.log(`Created:  ${f.created?.slice(0, 10)}  |  Updated: ${f.updated?.slice(0, 10)}`);

  // Description
  const desc = extractText(f.description);
  if (desc) console.log(`\nDescription:\n${desc}`);

  // Comments
  const comments = f.comment?.comments || [];
  if (comments.length) {
    console.log(`\nComments (${comments.length}):`);
    for (const c of comments.slice(-5)) {
      console.log(`\n  [${c.author?.displayName} — ${c.created?.slice(0, 10)}]`);
      console.log(`  ${extractText(c.body)}`);
    }
  }
}

async function cmdClose(args) {
  const key = args[0];
  const comment = args.slice(1).join(' ');
  if (!key || !comment) throw new Error('Usage: jira close <KEY> <comment>');

  if (comment) await api('POST', `/rest/api/3/issue/${key}/comment`, makeComment(comment));

  // Use the configured transition ID, or resolve one whose destination is in the
  // "Done" status category — so the script works on any workflow out of the box.
  let transitionId = process.env.JIRA_DONE_TRANSITION_ID || null;
  if (!transitionId) {
    const res = await api('GET', `/rest/api/3/issue/${key}/transitions`);
    const transitions = res.transitions || [];
    const match =
      transitions.find((t) => t.to?.statusCategory?.key === 'done') ||
      transitions.find((t) => t.to?.name?.toLowerCase() === 'done');
    if (!match) {
      console.log(`Available transitions: ${transitions.map((t) => `"${t.name}" → ${t.to?.name} (${t.id})`).join(', ')}`);
      throw new Error('Could not find a "Done" transition. Set JIRA_DONE_TRANSITION_ID.');
    }
    transitionId = match.id;
  }
  await api('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: transitionId } });
  console.log(`✓ ${key} closed.`);
}

async function cmdComment(args) {
  const key = args[0];
  const comment = args.slice(1).join(' ');
  if (!key || !comment) throw new Error('Usage: jira comment <KEY> <comment>');

  await api('POST', `/rest/api/3/issue/${key}/comment`, makeComment(comment));
  console.log(`✓ Comment added to ${key}.`);
}

async function cmdTransition(args) {
  const key = args[0];
  const targetStatus = args.slice(1).join(' ');
  if (!key || !targetStatus) throw new Error('Usage: jira transition <KEY> <status-name>');

  // Expand to get destination status so we can disambiguate duplicate transition names
  const res = await api('GET', `/rest/api/3/issue/${key}/transitions?expand=transitions.fields`);
  const transitions = res.transitions || [];
  const targetLower = targetStatus.toLowerCase();

  // Prefer a transition whose destination status name matches, then fall back to transition name
  let match = transitions.find((t) => t.to?.name?.toLowerCase() === targetLower);
  if (!match) match = transitions.find((t) => t.name.toLowerCase() === targetLower && t.to?.statusCategory?.name?.toLowerCase() !== 'in progress');
  if (!match) match = transitions.find((t) => t.name.toLowerCase() === targetLower);

  if (!match) {
    console.log(`Available transitions: ${transitions.map((t) => `"${t.name}" → ${t.to?.name} (${t.id})`).join(', ')}`);
    throw new Error(`No transition named "${targetStatus}"`);
  }
  await api('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: match.id } });
  console.log(`✓ ${key} transitioned to "${match.to?.name || match.name}".`);
}

async function cmdUpdate(args) {
  const key = args[0];
  if (!key) throw new Error('Usage: jira update <KEY> [--priority p] [--assignee email]');
  const flags = parseFlags(args.slice(1));
  const fields = {};

  if (flags.priority) fields.priority = { name: flags.priority };
  if (flags.issuetype) fields.issuetype = { name: flags.issuetype };
  if (flags.assignee) {
    // Look up account ID
    const res = await api('GET', `/rest/api/3/user/search?query=${encodeURIComponent(flags.assignee)}`);
    const user = (Array.isArray(res) ? res : [])[0];
    if (!user) throw new Error(`User not found: ${flags.assignee}`);
    fields.assignee = { accountId: user.accountId };
  }

  if (!Object.keys(fields).length) throw new Error('Provide at least one field to update (--priority, --assignee, --issuetype)');
  await api('PUT', `/rest/api/3/issue/${key}`, { fields });
  console.log(`✓ ${key} updated: ${Object.keys(fields).join(', ')}`);
}

async function cmdCreate(args) {
  const summary = args.find((a) => !a.startsWith('--'));
  if (!summary) throw new Error('Usage: jira create "<summary>" [--epic KEY] [--priority name] [--issuetype name] [--desc "text"]');
  const flags = parseFlags(args);

  // issuetype accepts a numeric ID or a type name (e.g. "Task", "Bug", "Story").
  const it = flags.issuetype || 'Task';
  const fields = {
    project: { key: JIRA_PROJECT },
    summary,
    issuetype: /^\d+$/.test(it) ? { id: it } : { name: it },
  };
  if (flags.priority) fields.priority = { name: flags.priority };
  if (flags.epic) fields.parent = { key: flags.epic };
  if (flags.desc) {
    fields.description = { type: 'doc', version: 1, content: textToADF(flags.desc) };
  }

  const res = await api('POST', '/rest/api/3/issue', { fields });
  console.log(`✓ Created ${res.key}: ${summary}`);
  console.log(`  https://${JIRA_HOST}/browse/${res.key}`);
}

async function cmdLink(args) {
  const key = args[0];
  const linkType = args[1];
  const target = args[2];
  if (!key || !linkType || !target) throw new Error('Usage: jira link <KEY> <link-type> <TARGET-KEY>');

  // Fetch available link types to find the right name/ID
  const res = await api('GET', '/rest/api/3/issueLinkType');
  const types = res.issueLinkTypes || [];
  const match = types.find(
    (t) =>
      t.name.toLowerCase() === linkType.toLowerCase() ||
      t.inward.toLowerCase() === linkType.toLowerCase() ||
      t.outward.toLowerCase() === linkType.toLowerCase()
  );
  if (!match) {
    console.log(`Available link types: ${types.map((t) => `"${t.name}" (in: ${t.inward}, out: ${t.outward})`).join('\n  ')}`);
    throw new Error(`No link type matching "${linkType}"`);
  }
  await api('POST', '/rest/api/3/issueLink', {
    type: { name: match.name },
    inwardIssue: { key: target },
    outwardIssue: { key: key },
  });
  console.log(`✓ Linked ${key} → ${target} (${match.name})`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const k = args[i].slice(2);
      flags[k] = args[i + 1] || true;
      i++;
    }
  }
  return flags;
}

function extractText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (node.content) return node.content.map(extractText).join('');
  return '';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const [, , cmd, ...rest] = process.argv;

const commands = { open: cmdOpen, view: cmdView, create: cmdCreate, close: cmdClose, comment: cmdComment, transition: cmdTransition, update: cmdUpdate, link: cmdLink };

if (!cmd || !commands[cmd]) {
  console.log(`Usage: node jira.cjs <command> [args]
Commands:
  open       [--epic KEY] [--status name] [--priority name]
  view       <KEY>
  create     "<summary>" [--epic KEY] [--priority name] [--issuetype name|id] [--desc "text"]
  close      <KEY> <comment>
  comment    <KEY> <comment>
  transition <KEY> <status-name>
  update     <KEY> [--priority p] [--assignee email] [--issuetype name]
  link       <KEY> <link-type> <TARGET-KEY>`);
  process.exit(1);
}

const missing = ['JIRA_API_TOKEN', 'JIRA_HOST', 'JIRA_EMAIL', 'JIRA_PROJECT'].filter((v) => !process.env[v]);
if (missing.length) {
  console.error(`Error: missing required config: ${missing.join(', ')}.`);
  console.error('Set them in jira.env or .env — see jira.env.example.');
  process.exit(1);
}

commands[cmd](rest).catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
