#!/usr/bin/env bun
// @bun
var __require = import.meta.require;

// tools/tribe.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Database as Database2 } from "bun:sqlite";
import { randomUUID } from "crypto";
import { existsSync as existsSync3, mkdirSync, readFileSync as readFileSync2 } from "fs";
import { dirname as dirname3, resolve as resolve3 } from "path";
import { parseArgs as parseArgs2 } from "util";

// tools/tribe-retro.ts
import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { parseArgs } from "util";
var { values: args } = parseArgs({
  options: {
    since: { type: "string", default: undefined },
    format: { type: "string", default: "markdown" },
    db: { type: "string", default: undefined }
  },
  strict: false
});
function findBeadsDir() {
  let dir = process.cwd();
  while (dir !== "/") {
    const candidate = resolve(dir, ".beads");
    if (existsSync(candidate))
      return candidate;
    dir = dirname(dir);
  }
  return resolve(process.cwd(), ".beads");
}
var DURATION_MULTIPLIERS = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
function parseDuration(s) {
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/);
  if (!match)
    throw new Error(`Invalid duration: "${s}" \u2014 use e.g. "2h", "30m", "1d"`);
  return parseFloat(match[1]) * DURATION_MULTIPLIERS[match[2]];
}
function formatDuration(ms) {
  if (ms < 1000)
    return `${ms}ms`;
  if (ms < 60000)
    return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) {
    const m2 = Math.floor(ms / 60000);
    const s = Math.round(ms % 60000 / 1000);
    return s > 0 ? `${m2}m ${s}s` : `${m2}m`;
  }
  const h = Math.floor(ms / 3600000);
  const m = Math.round(ms % 3600000 / 60000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
var formatTime = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
var formatDate = (ts) => new Date(ts).toISOString().slice(0, 10);
var snippet = (s, n = 80) => s.length > n ? s.slice(0, n) + "..." : s;
function makeMember(name, role, domains) {
  return { name, role, domains, sent: 0, received: 0, byType: {}, beads: new Set, avgResponseMs: null };
}
function getOrCreateMember(map, name) {
  let m = map.get(name);
  if (!m) {
    m = makeMember(name, "unknown", []);
    map.set(name, m);
  }
  return m;
}
function computeResponseTimes(messages) {
  const times = new Map;
  const answeredIds = new Set;
  const queryMap = new Map;
  const pendingByRecipient = new Map;
  for (const msg of messages) {
    if (msg.type === "query") {
      queryMap.set(msg.id, { sender: msg.sender, ts: msg.ts });
      if (msg.recipient !== "*") {
        const arr = pendingByRecipient.get(msg.recipient) ?? [];
        arr.push({ id: msg.id, ts: msg.ts });
        pendingByRecipient.set(msg.recipient, arr);
      }
    }
    if (msg.type === "response") {
      let queryTs;
      if (msg.ref && queryMap.has(msg.ref)) {
        queryTs = queryMap.get(msg.ref).ts;
        answeredIds.add(msg.ref);
      } else {
        const pending = pendingByRecipient.get(msg.sender);
        if (pending && pending.length > 0) {
          const q = pending.shift();
          queryTs = q.ts;
          answeredIds.add(q.id);
        }
      }
      if (queryTs !== undefined) {
        const arr = times.get(msg.sender) ?? [];
        arr.push(msg.ts - queryTs);
        times.set(msg.sender, arr);
      }
    }
  }
  return { times, answeredIds };
}
function generateRetro(db, sinceMs) {
  const now = Date.now();
  const windowStart = sinceMs ? now - sinceMs : getEarliestTimestamp(db);
  const windowEnd = now;
  const messages = db.prepare("SELECT * FROM messages WHERE ts >= ? ORDER BY ts ASC").all(windowStart);
  const sessions = db.prepare("SELECT * FROM sessions WHERE started_at <= ? AND heartbeat >= ?").all(windowEnd, windowStart);
  const sessionNames = new Set(sessions.map((s) => s.name));
  for (const sender of new Set(messages.map((m) => m.sender))) {
    if (!sessionNames.has(sender)) {
      const s = db.prepare("SELECT * FROM sessions WHERE name = ?").get(sender);
      if (s) {
        sessions.push(s);
        sessionNames.add(s.name);
      }
    }
  }
  const memberMap = new Map;
  for (const s of sessions)
    memberMap.set(s.name, makeMember(s.name, s.role, JSON.parse(s.domains)));
  const byType = {};
  for (const msg of messages) {
    byType[msg.type] = (byType[msg.type] ?? 0) + 1;
    const sender = getOrCreateMember(memberMap, msg.sender);
    sender.sent++;
    sender.byType[msg.type] = (sender.byType[msg.type] ?? 0) + 1;
    if (msg.bead_id)
      sender.beads.add(msg.bead_id);
    const beadRefs = msg.content.match(/\bkm-[\w.-]+/g);
    if (beadRefs)
      for (const ref of beadRefs)
        sender.beads.add(ref);
    if (msg.recipient === "*") {
      for (const [name, m] of memberMap) {
        if (name !== msg.sender)
          m.received++;
      }
    } else {
      getOrCreateMember(memberMap, msg.recipient).received++;
    }
  }
  const { times: responseTimes, answeredIds } = computeResponseTimes(messages);
  for (const [name, t] of responseTimes) {
    const member = memberMap.get(name);
    if (member && t.length > 0)
      member.avgResponseMs = t.reduce((a, b) => a + b, 0) / t.length;
  }
  const unansweredQueries = messages.filter((m) => m.type === "query" && !answeredIds.has(m.id)).length;
  const allTimes = [...responseTimes.values()].flat();
  const avgResponseTime = allTimes.length > 0 ? allTimes.reduce((a, b) => a + b, 0) / allTimes.length : null;
  const longestResponse = allTimes.length > 0 ? Math.max(...allTimes) : null;
  let longestResponseMember = null;
  if (longestResponse !== null) {
    for (const [name, t] of responseTimes)
      if (t.includes(longestResponse)) {
        longestResponseMember = name;
        break;
      }
  }
  const timeline = [];
  const events = db.prepare("SELECT * FROM events WHERE ts >= ? ORDER BY ts ASC").all(windowStart);
  const eventFormatters = {
    "session.joined": (ev, data) => `${ev.session} joined (${data.role ?? "member"})`,
    "session.left": (ev) => `${ev.session} left`,
    "session.renamed": (_, data) => `${data.old_name} renamed to ${data.new_name}`,
    "message.broadcast": (ev) => `${ev.session} broadcast a message`
  };
  for (const ev of events) {
    const fmt = eventFormatters[ev.type];
    if (fmt) {
      const text = fmt(ev, ev.data ? JSON.parse(ev.data) : {});
      if (text)
        timeline.push({ time: formatTime(ev.ts), event: text, ts: ev.ts });
    }
  }
  const msgFormatters = {
    assign: (m) => `${m.sender} assigned to ${m.recipient}: ${snippet(m.content)}`,
    request: (m) => `${m.sender} requested from ${m.recipient}: ${snippet(m.content)}`,
    verdict: (m) => `${m.recipient} received verdict: ${snippet(m.content)}`
  };
  for (const msg of messages) {
    const fmt = msgFormatters[msg.type];
    if (fmt)
      timeline.push({ time: formatTime(msg.ts), event: fmt(msg), ts: msg.ts });
  }
  timeline.sort((a, b) => a.ts - b.ts);
  const memberList = [...memberMap.values()].filter((m) => m.sent > 0 || m.received > 0).sort((a, b) => b.sent - a.sent).map((m) => ({
    name: m.name,
    role: m.role,
    domains: m.domains,
    sent: m.sent,
    received: m.received,
    beads_mentioned: [...m.beads].sort(),
    avg_response: m.avgResponseMs !== null ? formatDuration(m.avgResponseMs) : null
  }));
  const durationMs = windowEnd - windowStart;
  return {
    generated_at: new Date().toISOString(),
    window: { start: windowStart, end: windowEnd, duration_ms: durationMs },
    summary: {
      duration: formatDuration(durationMs),
      members: memberList.length,
      total_messages: messages.length,
      by_type: byType
    },
    members: memberList,
    timeline: timeline.map(({ time, event }) => ({ time, event })),
    coordination: {
      unanswered_queries: unansweredQueries,
      avg_response_time: avgResponseTime !== null ? formatDuration(avgResponseTime) : null,
      longest_response: longestResponse !== null ? formatDuration(longestResponse) : null,
      longest_response_member: longestResponseMember
    }
  };
}
function getEarliestTimestamp(db) {
  const row = db.prepare("SELECT MIN(ts) as min_ts FROM messages").get();
  if (row?.min_ts)
    return row.min_ts;
  const session = db.prepare("SELECT MIN(started_at) as min_ts FROM sessions").get();
  return session?.min_ts ?? Date.now();
}
function formatMarkdown(report) {
  const lines = [];
  lines.push(`# Tribe Retro \u2014 ${formatDate(report.window.start)}`, "");
  lines.push("## Summary");
  lines.push(`- Duration: ${report.summary.duration}`);
  lines.push(`- Members: ${report.summary.members} active (${report.members.map((m) => m.name).join(", ")})`);
  const typeBreakdown = Object.entries(report.summary.by_type).map(([t, c]) => `${c} ${t}`).join(", ");
  lines.push(`- Messages: ${report.summary.total_messages} total (${typeBreakdown})`, "");
  if (report.members.length > 0) {
    lines.push("## Per-Member Activity");
    lines.push("| Member | Sent | Received | Beads Mentioned | Avg Response |");
    lines.push("|--------|------|----------|-----------------|--------------|");
    for (const m of report.members)
      lines.push(`| ${m.name} | ${m.sent} | ${m.received} | ${m.beads_mentioned.length} | ${m.avg_response ?? "\u2014"} |`);
    lines.push("");
  }
  if (report.timeline.length > 0) {
    lines.push("## Timeline");
    for (const ev of report.timeline)
      lines.push(`- ${ev.time} \u2014 ${ev.event}`);
    lines.push("");
  }
  lines.push("## Coordination Health");
  lines.push(`- Unanswered queries: ${report.coordination.unanswered_queries}`);
  lines.push(`- Average response time: ${report.coordination.avg_response_time ?? "\u2014"}`);
  if (report.coordination.longest_response)
    lines.push(`- Longest response: ${report.coordination.longest_response} (${report.coordination.longest_response_member})`);
  lines.push("");
  return lines.join(`
`);
}
function main() {
  const dbPath = args.db ?? resolve(findBeadsDir(), "tribe.db");
  if (!existsSync(dbPath)) {
    console.error(`No tribe database found at ${dbPath}`);
    process.exit(1);
  }
  const db = new Database(dbPath, { readonly: true });
  db.run("PRAGMA busy_timeout = 5000");
  const sinceMs = args.since ? parseDuration(args.since) : undefined;
  const report = generateRetro(db, sinceMs);
  console.log(args.format === "json" ? JSON.stringify(report, null, 2) : formatMarkdown(report));
  db.close();
}
main();

// tools/lib/tribe/plugins.ts
import { existsSync as existsSync2, statSync, readFileSync } from "fs";
import { readFile } from "fs/promises";
import { resolve as resolve2 } from "path";
function beadsPlugin(opts = { beadsDir: null }) {
  return {
    name: "beads",
    available() {
      if (!opts.beadsDir)
        return false;
      const issuesPath = resolve2(opts.beadsDir, "backup/issues.jsonl");
      return existsSync2(issuesPath);
    },
    start(ctx) {
      if (!opts.beadsDir)
        return;
      const issuesPath = resolve2(opts.beadsDir, "backup/issues.jsonl");
      if (!existsSync2(issuesPath))
        return;
      let lastMtime = 0;
      const reportedStates = new Map;
      try {
        lastMtime = statSync(issuesPath).mtimeMs;
        for (const line of readFileSync(issuesPath, "utf8").split(`
`).filter(Boolean)) {
          try {
            const entry = JSON.parse(line);
            if (!entry.id)
              continue;
            const matchesName = !!ctx.sessionName && !!entry.claimed_by?.includes(ctx.sessionName);
            const matchesSession = !!ctx.claudeSessionId && !!entry.claimed_by?.includes(ctx.claudeSessionId);
            if (matchesName || matchesSession) {
              reportedStates.set(entry.id, "claimed");
            }
            if (entry.status === "closed") {
              reportedStates.set(entry.id, "closed");
            }
          } catch {}
        }
      } catch {}
      const interval = setInterval(async () => {
        if (!ctx.hasChief())
          return;
        try {
          const stat = statSync(issuesPath);
          if (stat.mtimeMs === lastMtime)
            return;
          lastMtime = stat.mtimeMs;
          const content = await readFile(issuesPath, "utf8");
          for (const line of content.split(`
`).filter(Boolean)) {
            try {
              const entry = JSON.parse(line);
              if (!entry.id)
                continue;
              const matchesName = !!ctx.sessionName && !!entry.claimed_by?.includes(ctx.sessionName);
              const matchesSession = !!ctx.claudeSessionId && !!entry.claimed_by?.includes(ctx.claudeSessionId);
              const isMyClaim = matchesName || matchesSession;
              if (isMyClaim && reportedStates.get(entry.id) !== "claimed") {
                reportedStates.set(entry.id, "claimed");
                if (!ctx.hasRecentMessage(`Claimed: ${entry.id}`)) {
                  ctx.sendMessage("chief", `Claimed: ${entry.id} \u2014 ${entry.title}`, "status", entry.id);
                }
              }
              if (isMyClaim && entry.status === "closed" && reportedStates.get(entry.id) !== "closed") {
                reportedStates.set(entry.id, "closed");
                if (!ctx.hasRecentMessage(`Closed: ${entry.id}`)) {
                  ctx.sendMessage("chief", `Closed: ${entry.id} \u2014 ${entry.title}`, "status", entry.id);
                }
              }
            } catch {}
          }
        } catch {}
      }, 30000);
      return () => clearInterval(interval);
    },
    instructions() {
      return "- Beads integration active: use `bd create`, `bd update`, `bd close` for task tracking";
    }
  };
}
function gitPlugin() {
  return {
    name: "git",
    available() {
      try {
        const { execSync } = __require("child_process");
        execSync("git rev-parse HEAD", { cwd: process.cwd(), encoding: "utf8" });
        return true;
      } catch {
        return false;
      }
    },
    start(ctx) {
      const { execSync } = __require("child_process");
      let lastHead = "";
      try {
        lastHead = execSync("git rev-parse HEAD", { cwd: process.cwd(), encoding: "utf8" }).trim();
      } catch {}
      const interval = setInterval(async () => {
        if (!ctx.hasChief())
          return;
        try {
          const proc = Bun.spawn(["git", "log", "--oneline", "-1", "HEAD"], {
            cwd: process.cwd(),
            stdout: "pipe",
            stderr: "ignore"
          });
          const out = await new Response(proc.stdout).text();
          const line = out.trim();
          const head = line.split(" ")[0] ?? "";
          if (head && lastHead && head !== lastHead) {
            if (!ctx.hasRecentMessage(`Committed: ${head}`)) {
              ctx.sendMessage("chief", `Committed: ${line}`, "status");
            }
            try {
              const diffProc = Bun.spawn(["git", "diff", "--name-only", lastHead, head], {
                cwd: process.cwd(),
                stdout: "pipe",
                stderr: "ignore"
              });
              const diffOut = await new Response(diffProc.stdout).text();
              if (diffOut.includes("tools/tribe.ts") || diffOut.includes("tools/lib/tribe/")) {
                process.stderr.write(`[tribe] tribe code changed in ${head}, auto-reloading
`);
                ctx.triggerReload?.(`tribe code changed in ${head}`);
              }
            } catch {}
          }
          if (head)
            lastHead = head;
        } catch {}
      }, 30000);
      return () => clearInterval(interval);
    }
  };
}
function loadPlugins(plugins, ctx) {
  const cleanups = [];
  for (const plugin of plugins) {
    if (!plugin.available()) {
      process.stderr.write(`[tribe] plugin ${plugin.name}: not available (skipped)
`);
      continue;
    }
    process.stderr.write(`[tribe] plugin ${plugin.name}: active
`);
    if (plugin.start) {
      const cleanup = plugin.start(ctx);
      if (cleanup)
        cleanups.push(cleanup);
    }
  }
  return () => {
    for (const fn of cleanups)
      fn();
  };
}

// tools/tribe.ts
var { values: args2 } = parseArgs2({
  options: {
    name: { type: "string", default: process.env.TRIBE_NAME },
    role: { type: "string", default: process.env.TRIBE_ROLE },
    domains: { type: "string", default: process.env.TRIBE_DOMAINS ?? "" },
    db: { type: "string", default: process.env.TRIBE_DB },
    "auto-report": { type: "boolean", default: (process.env.TRIBE_AUTO_REPORT ?? "1") === "1" }
  },
  strict: false
});
var SESSION_DOMAINS = String(args2.domains ?? "").split(",").filter(Boolean);
var SESSION_ID = randomUUID();
var CLAUDE_SESSION_ID = process.env.CLAUDE_SESSION_ID ?? process.env.BD_ACTOR?.replace("claude:", "") ?? null;
var CLAUDE_SESSION_NAME = process.env.CLAUDE_SESSION_NAME ?? null;
function findBeadsDir2() {
  let dir = process.cwd();
  while (dir !== "/") {
    const candidate = resolve3(dir, ".beads");
    if (existsSync3(candidate))
      return candidate;
    dir = dirname3(dir);
  }
  return null;
}
function resolveDbPath() {
  if (args2.db)
    return String(args2.db);
  if (process.env.TRIBE_DB)
    return process.env.TRIBE_DB;
  const beadsDir = findBeadsDir2();
  if (beadsDir)
    return resolve3(beadsDir, "tribe.db");
  const xdgData = process.env.XDG_DATA_HOME ?? resolve3(process.env.HOME ?? "~", ".local/share");
  const tribeDir = resolve3(xdgData, "tribe");
  mkdirSync(tribeDir, { recursive: true });
  return resolve3(tribeDir, "tribe.db");
}
var BEADS_DIR = findBeadsDir2();
var DB_PATH = resolveDbPath();
function detectRole(db) {
  if (args2.role)
    return args2.role;
  const threshold = Date.now() - 30000;
  const liveChief = db.prepare("SELECT name FROM sessions WHERE role = 'chief' AND heartbeat > ?").get(threshold);
  return liveChief ? "member" : "chief";
}
function detectName(db, role) {
  if (args2.name)
    return String(args2.name);
  if (role === "chief")
    return "chief";
  const pidName = `member-${process.pid}`;
  const taken = db.prepare("SELECT id FROM sessions WHERE name = ? AND pruned_at IS NULL").get(pidName);
  if (!taken)
    return pidName;
  return `member-${process.pid}-${Math.random().toString(36).slice(2, 5)}`;
}
function openDatabase(path) {
  const db = new Database2(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
		id         TEXT PRIMARY KEY,
		name       TEXT NOT NULL UNIQUE,
		role       TEXT NOT NULL,
		domains    TEXT NOT NULL DEFAULT '[]',
		pid        INTEGER NOT NULL,
		cwd        TEXT,
		claude_session_id TEXT,
		claude_session_name TEXT,
		started_at INTEGER NOT NULL,
		heartbeat  INTEGER NOT NULL,
		pruned_at  INTEGER
	)`);
  try {
    db.run("ALTER TABLE sessions ADD COLUMN claude_session_id TEXT");
  } catch {}
  try {
    db.run("ALTER TABLE sessions ADD COLUMN claude_session_name TEXT");
  } catch {}
  try {
    db.run("ALTER TABLE sessions ADD COLUMN pruned_at INTEGER");
  } catch {}
  try {
    db.run("ALTER TABLE sessions ADD COLUMN last_delivered_ts INTEGER");
  } catch {}
  try {
    db.run("ALTER TABLE sessions ADD COLUMN last_delivered_seq INTEGER DEFAULT 0");
  } catch {}
  db.run(`CREATE TABLE IF NOT EXISTS aliases (
		old_name   TEXT PRIMARY KEY,
		session_id TEXT NOT NULL,
		renamed_at INTEGER NOT NULL
	)`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (
		id         TEXT PRIMARY KEY,
		type       TEXT NOT NULL,
		sender     TEXT NOT NULL,
		recipient  TEXT NOT NULL,
		content    TEXT NOT NULL,
		bead_id    TEXT,
		ref        TEXT,
		ts         INTEGER NOT NULL
	)`);
  db.run(`CREATE TABLE IF NOT EXISTS cursors (
		session_id   TEXT PRIMARY KEY,
		last_read_ts INTEGER NOT NULL,
		last_seq     INTEGER DEFAULT 0
	)`);
  try {
    db.run("ALTER TABLE cursors ADD COLUMN last_seq INTEGER DEFAULT 0");
  } catch {}
  db.run(`CREATE TABLE IF NOT EXISTS reads (
		message_id TEXT NOT NULL,
		session_id TEXT NOT NULL,
		read_at    INTEGER NOT NULL,
		PRIMARY KEY (message_id, session_id)
	)`);
  db.run(`CREATE TABLE IF NOT EXISTS events (
		id       TEXT PRIMARY KEY,
		type     TEXT NOT NULL,
		session  TEXT,
		bead_id  TEXT,
		data     TEXT,
		ts       INTEGER NOT NULL
	)`);
  db.run(`CREATE TABLE IF NOT EXISTS retros (
		id          TEXT PRIMARY KEY,
		tribe_start INTEGER NOT NULL,
		tribe_end   INTEGER NOT NULL,
		members     TEXT NOT NULL,
		metrics     TEXT NOT NULL,
		lessons     TEXT NOT NULL,
		full_md     TEXT NOT NULL,
		ts          INTEGER NOT NULL
	)`);
  db.run(`CREATE TABLE IF NOT EXISTS leadership (
		role         TEXT PRIMARY KEY DEFAULT 'chief',
		holder_id    TEXT NOT NULL,
		holder_name  TEXT NOT NULL,
		term         INTEGER NOT NULL DEFAULT 1,
		lease_until  INTEGER NOT NULL,
		acquired_at  INTEGER NOT NULL
	)`);
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_recipient_ts ON messages(recipient, ts)");
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender)");
  db.run("CREATE INDEX IF NOT EXISTS idx_aliases_session ON aliases(session_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts)");
  db.run("CREATE INDEX IF NOT EXISTS idx_events_bead ON events(bead_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_events_session ON events(session)");
  db.run("CREATE INDEX IF NOT EXISTS idx_reads_session ON reads(session_id, message_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_sessions_pruned ON sessions(pruned_at, heartbeat)");
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts)");
  return db;
}
var db = openDatabase(String(DB_PATH));
var SESSION_ROLE = detectRole(db);
var SESSION_NAME = detectName(db, SESSION_ROLE);
function validateName(name) {
  if (!/^[a-z0-9][a-z0-9_.-]{0,31}$/.test(name)) {
    return "Name must be 1-32 chars: lowercase letters, digits, hyphens, underscores, dots. Must start with letter or digit.";
  }
  return null;
}
function sanitizeMessage(content) {
  const cleaned = content.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, "");
  if (cleaned.length > 4096)
    return cleaned.slice(0, 4093) + "...";
  return cleaned;
}
var LEASE_DURATION_MS = 60000;
function acquireLease(id, name) {
  const leaseUntil = Date.now() + LEASE_DURATION_MS;
  const acquired = Date.now();
  try {
    db.run(`INSERT INTO leadership (role, holder_id, holder_name, term, lease_until, acquired_at)
       VALUES ('chief', $id, $name, 1, $lease_until, $acquired)`, { $id: id, $name: name, $lease_until: leaseUntil, $acquired: acquired });
    return true;
  } catch {
    const result = db.run(`UPDATE leadership SET holder_id = $id, holder_name = $name, term = term + 1,
         lease_until = $lease_until, acquired_at = $acquired
       WHERE role = 'chief' AND (lease_until < $now OR holder_id = $id)`, { $id: id, $name: name, $lease_until: leaseUntil, $acquired: acquired, $now: Date.now() });
    return result.changes > 0;
  }
}
function isLeaseHolder(id) {
  const row = db.prepare("SELECT holder_id FROM leadership WHERE role = 'chief' AND holder_id = $id AND lease_until > $now").get({ $id: id, $now: Date.now() });
  return !!row;
}
function getLeaseInfo() {
  return db.prepare("SELECT holder_name, holder_id, term, lease_until, acquired_at FROM leadership WHERE role = 'chief'").get();
}
process.stderr.write(`[tribe] ${SESSION_NAME} (${SESSION_ROLE}) joining tribe at ${DB_PATH}
`);
process.stderr.write(`[tribe] claude_session_id=${CLAUDE_SESSION_ID ?? "none"}
`);
if (SESSION_DOMAINS.length > 0) {
  process.stderr.write(`[tribe] domains: ${SESSION_DOMAINS.join(", ")}
`);
}
if (SESSION_ROLE === "chief") {
  const leased = acquireLease(SESSION_ID, SESSION_NAME);
  process.stderr.write(`[tribe] leader lease: ${leased ? "acquired" : "held by another"}
`);
}
var stmts = {
  upsertSession: db.prepare(`
		INSERT INTO sessions (id, name, role, domains, pid, cwd, claude_session_id, claude_session_name, started_at, heartbeat, pruned_at)
		VALUES ($id, $name, $role, $domains, $pid, $cwd, $claude_session_id, $claude_session_name, $now, $now, NULL)
		ON CONFLICT(id) DO UPDATE SET
			name = $name, role = $role, domains = $domains,
			pid = $pid, cwd = $cwd, claude_session_id = $claude_session_id,
			claude_session_name = $claude_session_name, started_at = $now, heartbeat = $now, pruned_at = NULL
	`),
  heartbeat: db.prepare("UPDATE sessions SET heartbeat = $now, pruned_at = NULL WHERE id = $id"),
  pollMessages: db.prepare(`
		SELECT rowid, * FROM messages
		WHERE rowid > $last_seq
		AND id NOT IN (SELECT message_id FROM reads WHERE session_id = $session_id)
		AND (
			recipient = $name
			OR recipient = '*'
			OR recipient IN (SELECT old_name FROM aliases WHERE session_id = $session_id)
		)
		ORDER BY
			CASE type
				WHEN 'assign' THEN 0
				WHEN 'request' THEN 1
				WHEN 'verdict' THEN 2
				WHEN 'query' THEN 3
				WHEN 'response' THEN 4
				WHEN 'status' THEN 5
				WHEN 'notify' THEN 6
				ELSE 7
			END,
			rowid ASC
	`),
  markRead: db.prepare("INSERT OR IGNORE INTO reads (message_id, session_id, read_at) VALUES ($message_id, $session_id, $now)"),
  getCursor: db.prepare("SELECT last_read_ts, last_seq FROM cursors WHERE session_id = $session_id"),
  upsertCursor: db.prepare(`
		INSERT INTO cursors (session_id, last_read_ts, last_seq)
		VALUES ($session_id, $ts, $seq)
		ON CONFLICT(session_id) DO UPDATE SET last_read_ts = $ts, last_seq = $seq
	`),
  insertMessage: db.prepare(`
		INSERT INTO messages (id, type, sender, recipient, content, bead_id, ref, ts)
		VALUES ($id, $type, $sender, $recipient, $content, $bead_id, $ref, $ts)
	`),
  insertEvent: db.prepare(`
		INSERT INTO events (id, type, session, bead_id, data, ts)
		VALUES ($id, $type, $session, $bead_id, $data, $ts)
	`),
  liveSessions: db.prepare(`
		SELECT id, name, role, domains, pid, cwd, claude_session_id, claude_session_name, started_at, heartbeat, pruned_at
		FROM sessions
		WHERE heartbeat > $threshold AND pruned_at IS NULL
	`),
  allSessions: db.prepare("SELECT id, name, role, domains, pid, cwd, claude_session_id, claude_session_name, started_at, heartbeat, pruned_at FROM sessions"),
  messageHistory: db.prepare(`
		SELECT * FROM messages
		WHERE (sender = $name OR recipient = $name OR recipient = '*')
		ORDER BY ts DESC
		LIMIT $limit
	`),
  checkNameTaken: db.prepare("SELECT id FROM sessions WHERE name = $name AND id != $session_id AND pruned_at IS NULL"),
  insertAlias: db.prepare(`
		INSERT OR REPLACE INTO aliases (old_name, session_id, renamed_at)
		VALUES ($old_name, $session_id, $now)
	`),
  renameSession: db.prepare("UPDATE sessions SET name = $new_name WHERE id = $session_id"),
  pruneSession: db.prepare("UPDATE sessions SET pruned_at = $now, name = $pruned_name WHERE id = $id"),
  updateSessionMeta: db.prepare(`
		UPDATE sessions SET name = $name, role = $role, domains = $domains, heartbeat = $now, pruned_at = NULL
		WHERE id = $id
	`),
  hasRecentMessage: db.prepare(`
		SELECT 1 FROM messages WHERE content LIKE $prefix || '%' AND ts > $since LIMIT 1
	`),
  updateLastDelivered: db.prepare("UPDATE sessions SET last_delivered_ts = $ts, last_delivered_seq = $seq WHERE id = $id"),
  getLastDelivered: db.prepare("SELECT last_delivered_ts, last_delivered_seq FROM sessions WHERE id = $id"),
  activeSessions: db.prepare("SELECT id, name, role, domains, pid, cwd, claude_session_id, claude_session_name, started_at, heartbeat, pruned_at FROM sessions WHERE pruned_at IS NULL"),
  deleteOldPrunedSessions: db.prepare("DELETE FROM sessions WHERE pruned_at IS NOT NULL AND pruned_at < $cutoff")
};
var currentName = SESSION_NAME;
function now() {
  return Date.now();
}
function registerSession() {
  try {
    stmts.upsertSession.run({
      $id: SESSION_ID,
      $name: currentName,
      $role: SESSION_ROLE,
      $domains: JSON.stringify(SESSION_DOMAINS),
      $pid: process.pid,
      $cwd: process.cwd(),
      $claude_session_id: CLAUDE_SESSION_ID,
      $claude_session_name: CLAUDE_SESSION_NAME,
      $now: now()
    });
  } catch (err) {
    const fallbackName = `${currentName}-${Math.random().toString(36).slice(2, 5)}`;
    process.stderr.write(`[tribe] name "${currentName}" taken, using "${fallbackName}"
`);
    currentName = fallbackName;
    stmts.upsertSession.run({
      $id: SESSION_ID,
      $name: currentName,
      $role: SESSION_ROLE,
      $domains: JSON.stringify(SESSION_DOMAINS),
      $pid: process.pid,
      $cwd: process.cwd(),
      $claude_session_id: CLAUDE_SESSION_ID,
      $claude_session_name: CLAUDE_SESSION_NAME,
      $now: now()
    });
  }
  stmts.insertEvent.run({
    $id: randomUUID(),
    $type: "session.joined",
    $session: currentName,
    $bead_id: null,
    $data: JSON.stringify({ name: currentName, role: SESSION_ROLE, domains: SESSION_DOMAINS }),
    $ts: now()
  });
  const cursor = stmts.getCursor.get({ $session_id: SESSION_ID });
  if (!cursor) {
    let initialTs = 0;
    let initialSeq = 0;
    if (CLAUDE_SESSION_ID) {
      const prior = db.prepare("SELECT last_delivered_ts, last_delivered_seq FROM sessions WHERE claude_session_id = $csid AND id != $id AND last_delivered_ts IS NOT NULL ORDER BY last_delivered_ts DESC LIMIT 1").get({ $csid: CLAUDE_SESSION_ID, $id: SESSION_ID });
      if (prior?.last_delivered_ts) {
        initialTs = prior.last_delivered_ts;
        initialSeq = prior.last_delivered_seq ?? 0;
        process.stderr.write(`[tribe] recovered cursor from prior session: seq=${initialSeq} ts=${new Date(initialTs).toISOString()}
`);
      }
    }
    if (initialSeq === 0 && initialTs > 0) {
      const maxRow = db.prepare("SELECT MAX(rowid) as max_rowid FROM messages WHERE ts <= $ts").get({ $ts: initialTs });
      initialSeq = maxRow?.max_rowid ?? 0;
      process.stderr.write(`[tribe] migrated ts cursor to seq=${initialSeq}
`);
    }
    stmts.upsertCursor.run({ $session_id: SESSION_ID, $ts: initialTs, $seq: initialSeq });
  } else if (!cursor.last_seq) {
    const maxRow = db.prepare("SELECT MAX(rowid) as max_rowid FROM messages WHERE ts <= $ts").get({ $ts: cursor.last_read_ts });
    const migratedSeq = maxRow?.max_rowid ?? 0;
    stmts.upsertCursor.run({ $session_id: SESSION_ID, $ts: cursor.last_read_ts, $seq: migratedSeq });
    process.stderr.write(`[tribe] migrated existing cursor to seq=${migratedSeq}
`);
  }
}
var userRenamed = false;
function resolveTranscriptPath() {
  if (!CLAUDE_SESSION_ID)
    return null;
  const cwd = process.cwd();
  const projectKey = "-" + cwd.replace(/\//g, "-");
  const transcriptPath = resolve3(process.env.HOME ?? "~", ".claude/projects", projectKey, `${CLAUDE_SESSION_ID}.jsonl`);
  return existsSync3(transcriptPath) ? transcriptPath : null;
}
var TRANSCRIPT_PATH = resolveTranscriptPath();
function readTranscriptSlug() {
  if (!TRANSCRIPT_PATH)
    return null;
  try {
    const size = Bun.file(TRANSCRIPT_PATH).size;
    if (size === 0)
      return null;
    const text = new TextDecoder().decode(new Uint8Array(readFileSync2(TRANSCRIPT_PATH).buffer.slice(Math.max(0, size - 4096))));
    const lines = text.trimEnd().split(`
`);
    const lastLine = lines[lines.length - 1];
    if (!lastLine)
      return null;
    const data = JSON.parse(lastLine);
    return data.slug ?? null;
  } catch {
    return null;
  }
}
function tryInitialRename() {
  if (!currentName.startsWith("member-"))
    return;
  const slug = readTranscriptSlug();
  if (!slug || slug === currentName)
    return;
  const existing = stmts.checkNameTaken.get({ $name: slug, $session_id: SESSION_ID });
  if (existing)
    return;
  const oldName = currentName;
  stmts.insertAlias.run({ $old_name: oldName, $session_id: SESSION_ID, $now: now() });
  stmts.renameSession.run({ $new_name: slug, $session_id: SESSION_ID });
  currentName = slug;
  sendMessage("*", `Member "${oldName}" is now "${slug}"`, "notify");
  logEvent("session.renamed", undefined, { old_name: oldName, new_name: slug, source: "initial-slug" });
  process.stderr.write(`[tribe] initial name from /rename: ${oldName} \u2192 ${slug}
`);
}
function cleanupOldPrunedSessions() {
  const cutoff = now() - 24 * 60 * 60 * 1000;
  const result = stmts.deleteOldPrunedSessions.run({ $cutoff: cutoff });
  if (result.changes > 0) {
    process.stderr.write(`[tribe] cleaned up ${result.changes} old pruned session(s)
`);
  }
}
function cleanupOldData() {
  const READS_TTL = 7 * 24 * 60 * 60 * 1000;
  const DATA_TTL = 30 * 24 * 60 * 60 * 1000;
  const now_ms = Date.now();
  const readsDel = db.prepare("DELETE FROM reads WHERE read_at < $cutoff").run({ $cutoff: now_ms - READS_TTL });
  const eventsDel = db.prepare("DELETE FROM events WHERE ts < $cutoff").run({ $cutoff: now_ms - DATA_TTL });
  const msgsDel = db.prepare("DELETE FROM messages WHERE ts < $cutoff").run({ $cutoff: now_ms - DATA_TTL });
  const aliasesDel = db.prepare("DELETE FROM aliases WHERE renamed_at < $cutoff").run({ $cutoff: now_ms - DATA_TTL });
  const total = (readsDel.changes ?? 0) + (eventsDel.changes ?? 0) + (msgsDel.changes ?? 0) + (aliasesDel.changes ?? 0);
  if (total > 0) {
    process.stderr.write(`[tribe] cleanup: ${readsDel.changes} reads, ${eventsDel.changes} events, ${msgsDel.changes} msgs, ${aliasesDel.changes} aliases deleted
`);
  }
}
function sendHeartbeat() {
  const session = db.prepare("SELECT pruned_at FROM sessions WHERE id = ?").get(SESSION_ID);
  if (session?.pruned_at) {
    logEvent("session.rejoined", undefined, { name: currentName, role: SESSION_ROLE, domains: SESSION_DOMAINS });
    process.stderr.write(`[tribe] ${currentName} rejoined tribe (was pruned)
`);
    registerSession();
    return;
  }
  stmts.heartbeat.run({ $id: SESSION_ID, $now: now() });
  if (SESSION_ROLE === "chief") {
    acquireLease(SESSION_ID, currentName);
  }
}
function sendMessage(recipient, content, type = "notify", bead_id, ref) {
  const id = randomUUID();
  stmts.insertMessage.run({
    $id: id,
    $type: type,
    $sender: currentName,
    $recipient: recipient,
    $content: content,
    $bead_id: bead_id ?? null,
    $ref: ref ?? null,
    $ts: now()
  });
  return { id };
}
function logEvent(type, bead_id, data) {
  stmts.insertEvent.run({
    $id: randomUUID(),
    $type: type,
    $session: currentName,
    $bead_id: bead_id ?? null,
    $data: data ? JSON.stringify(data) : null,
    $ts: now()
  });
}
var chiefInstructions = `Messages from other Claude Code sessions arrive as <channel source="tribe" from="..." type="..." bead="...">.

You are the chief of a tribe \u2014 a coordinator for multiple Claude Code sessions working on the same project.

Coordination protocol:
- Use tribe_sessions() to see who's online and their domains
- Use tribe_send(to, message, type) to assign work, answer queries, or approve requests
- Use tribe_broadcast(message) to announce changes that affect everyone
- Use tribe_health() to check for silent members or conflicts
- If beads are available (bd command exists), use bd create/update/close for persistent task tracking

When a member sends a "status" message, update any relevant tracking.
When a member sends a "request" message, check for conflicts before approving.
When a member sends a "query" message, either answer directly or route to the right member.
When a member goes silent (tribe_health shows warning), send a query to check on them.
If a member dies (heartbeat timeout), reassign their beads to another member.

Message format rules:
- Keep messages SHORT \u2014 1-3 lines max. No essays.
- Use plain text only \u2014 no markdown (**bold**, headers, bullets). It renders as ugly escaped text.
- For sync broadcasts: keep the template concise, ask for one-line responses.
- Don't send overlapping sync/rollcall requests \u2014 one at a time, wait for responses.
- Batch-acknowledge: if you receive many messages at once, one summary covers all.`;
var memberInstructions = `Messages from other Claude Code sessions arrive as <channel source="tribe" from="..." type="..." bead="...">.

You are a tribe member \u2014 a worker session coordinated by the chief.

Coordination protocol:
- When you claim a bead, send a status to chief
- When you commit a fix, send a status to chief with the commit hash
- When you're blocked, send a status to chief immediately \u2014 include what would unblock you
- Before editing vendor/ or shared files, send a request to chief asking for OK
- If you discover a new bug, create a bead and notify the tribe
- When all assigned work is done, send a status: "Available"
- Respond to query messages promptly

Infrastructure reporting \u2014 notify chief when you:
- Begin or complete a multi-file refactor (others may not be able to build)
- Need an npm package that hasn't been published yet
- Create or merge a git worktree
- Modify shared config (package.json, tsconfig, .mcp.json)
- Experience slowdowns (CPU contention from concurrent test runs, etc.)

Message format rules:
- Keep messages SHORT \u2014 1-3 lines max. No essays.
- Use plain text only \u2014 no markdown (**bold**, headers, bullets). It renders as ugly escaped text.
- For sync responses: "Session: name | Idle: Xm | Closed: N beads | Blockers: none | Available"
- For status: "Claimed km-foo.bar" or "Committed abc1234 fix(scope): message" or "Available"
- For blocking: "Blocked on km-foo.bar \u2014 need X to unblock"
- Batch-acknowledge stale messages: "Acknowledged N old messages, no action needed" (one line, not per-message)
- NEVER respond to messages individually if you received a batch \u2014 one summary response covers all.

Don't over-communicate \u2014 only send messages when it changes what someone else should do.`;
var mcp = new Server({ name: "tribe", version: "0.1.0" }, {
  capabilities: {
    experimental: { "claude/channel": {} },
    tools: {}
  },
  instructions: SESSION_ROLE === "chief" ? chiefInstructions : memberInstructions
});
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "tribe_send",
      description: "Send a message to a specific tribe member",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient session name" },
          message: { type: "string", description: "Message content" },
          type: {
            type: "string",
            description: "Message type",
            enum: ["assign", "status", "query", "response", "notify", "request", "verdict"],
            default: "notify"
          },
          bead: { type: "string", description: "Associated bead ID (optional)" },
          ref: { type: "string", description: "Reference to a previous message ID (optional)" }
        },
        required: ["to", "message"]
      }
    },
    {
      name: "tribe_broadcast",
      description: "Broadcast a message to all tribe members",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Message content" },
          type: {
            type: "string",
            description: "Message type",
            enum: ["notify", "status"],
            default: "notify"
          },
          bead: { type: "string", description: "Associated bead ID (optional)" }
        },
        required: ["message"]
      }
    },
    {
      name: "tribe_sessions",
      description: "List active tribe sessions with their roles and domains",
      inputSchema: {
        type: "object",
        properties: {
          all: { type: "boolean", description: "Include dead sessions (default: false)" }
        }
      }
    },
    {
      name: "tribe_history",
      description: "View recent message history",
      inputSchema: {
        type: "object",
        properties: {
          with: { type: "string", description: "Filter to messages involving this session" },
          limit: { type: "number", description: "Max messages to return (default: 20)" }
        }
      }
    },
    {
      name: "tribe_rename",
      description: "Rename this session in the tribe",
      inputSchema: {
        type: "object",
        properties: {
          new_name: { type: "string", description: "New session name" }
        },
        required: ["new_name"]
      }
    },
    {
      name: "tribe_health",
      description: "Diagnostic: check for silent members, stale beads, unread messages",
      inputSchema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "tribe_join",
      description: "Re-announce this session's name, role, and domains (e.g. after compaction/rejoin)",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Session name" },
          role: {
            type: "string",
            description: "Session role",
            enum: ["chief", "member"]
          },
          domains: {
            type: "array",
            items: { type: "string" },
            description: "Domain expertise areas (e.g. ['silvery', 'flexily'])"
          }
        },
        required: ["name", "role"]
      }
    },
    {
      name: "tribe_reload",
      description: "Hot-reload the tribe MCP server \u2014 re-exec with latest code from disk. Use after tribe.ts is updated to pick up fixes without restarting the Claude Code session.",
      inputSchema: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Why the reload is needed (logged to events)"
          }
        }
      }
    },
    {
      name: "tribe_retro",
      description: "Generate a retrospective report analyzing tribe message history, coordination health, and per-member activity",
      inputSchema: {
        type: "object",
        properties: {
          since: {
            type: "string",
            description: 'Duration to look back (e.g. "2h", "30m", "1d"). Default: entire session.'
          },
          format: {
            type: "string",
            description: "Output format",
            enum: ["markdown", "json"],
            default: "markdown"
          }
        }
      }
    },
    {
      name: "tribe_leadership",
      description: "Show the current chief lease holder, term number, and time until expiry",
      inputSchema: {
        type: "object",
        properties: {}
      }
    }
  ]
}));
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: toolArgs } = req.params;
  const a = toolArgs ?? {};
  switch (name) {
    case "tribe_send": {
      const msgType = a.type ?? "notify";
      if ((msgType === "assign" || msgType === "verdict") && !isLeaseHolder(SESSION_ID)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "Only the current chief lease holder can send assign/verdict messages" })
            }
          ]
        };
      }
      const sanitized = sanitizeMessage(a.message);
      const result = sendMessage(a.to, sanitized, msgType, a.bead, a.ref);
      logEvent(`message.sent.${msgType}`, a.bead, {
        to: a.to,
        message_id: result.id
      });
      return { content: [{ type: "text", text: JSON.stringify({ sent: true, id: result.id }) }] };
    }
    case "tribe_broadcast": {
      const sanitized = sanitizeMessage(a.message);
      const result = sendMessage("*", sanitized, a.type ?? "notify", a.bead);
      logEvent("message.broadcast", a.bead, { message_id: result.id });
      return { content: [{ type: "text", text: JSON.stringify({ sent: true, id: result.id }) }] };
    }
    case "tribe_sessions": {
      const threshold = now() - 30000;
      const rows = stmts.allSessions.all();
      const dead = [];
      for (const r of rows) {
        if (r.pid === process.pid)
          continue;
        if (r.pruned_at)
          continue;
        try {
          process.kill(r.pid, 0);
        } catch {
          dead.push(r.name);
          const pruneTs = now();
          stmts.pruneSession.run({ $id: r.id, $now: pruneTs, $pruned_name: `${r.name}-pruned-${pruneTs}` });
        }
      }
      const liveRows = a.all ? stmts.allSessions.all() : stmts.liveSessions.all({ $threshold: threshold });
      const sessions = liveRows.map((r) => ({
        name: r.name,
        role: r.role,
        domains: JSON.parse(r.domains),
        pid: r.pid,
        cwd: r.cwd,
        claude_session_id: r.claude_session_id,
        claude_session_name: r.claude_session_name,
        alive: r.heartbeat > threshold && !r.pruned_at,
        pruned: !!r.pruned_at,
        uptime_min: Math.round((now() - r.started_at) / 60000),
        last_heartbeat_sec: Math.round((now() - r.heartbeat) / 1000)
      }));
      const result = { sessions };
      if (dead.length > 0)
        result.pruned = dead;
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    case "tribe_history": {
      const who = a.with ?? currentName;
      const limit = a.limit ?? 20;
      const rows = stmts.messageHistory.all({ $name: who, $limit: limit });
      const messages = rows.map((r) => ({
        id: r.id,
        type: r.type,
        from: r.sender,
        to: r.recipient,
        content: r.content,
        bead: r.bead_id,
        ref: r.ref,
        ts: new Date(r.ts).toISOString(),
        read: !!r.read_at
      }));
      return { content: [{ type: "text", text: JSON.stringify(messages, null, 2) }] };
    }
    case "tribe_rename": {
      const newName = a.new_name;
      const nameError = validateName(newName);
      if (nameError) {
        return { content: [{ type: "text", text: JSON.stringify({ error: nameError }) }] };
      }
      const existing = stmts.checkNameTaken.get({ $name: newName, $session_id: SESSION_ID });
      if (existing) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Name "${newName}" is already taken` }) }] };
      }
      const oldName = currentName;
      stmts.insertAlias.run({ $old_name: oldName, $session_id: SESSION_ID, $now: now() });
      stmts.renameSession.run({ $new_name: newName, $session_id: SESSION_ID });
      currentName = newName;
      userRenamed = true;
      sendMessage("*", `Member "${oldName}" is now "${newName}"`, "notify");
      logEvent("session.renamed", undefined, { old_name: oldName, new_name: newName });
      return {
        content: [{ type: "text", text: JSON.stringify({ renamed: true, old_name: oldName, new_name: newName }) }]
      };
    }
    case "tribe_join": {
      const joinName = a.name;
      const joinRole = a.role ?? SESSION_ROLE;
      const joinDomains = a.domains ?? SESSION_DOMAINS;
      const joinNameError = validateName(joinName);
      if (joinNameError) {
        return { content: [{ type: "text", text: JSON.stringify({ error: joinNameError }) }] };
      }
      const taken = stmts.checkNameTaken.get({ $name: joinName, $session_id: SESSION_ID });
      if (taken) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Name "${joinName}" is already taken` }) }] };
      }
      if (joinRole === "chief") {
        const leased = acquireLease(SESSION_ID, joinName);
        if (!leased) {
          const info = getLeaseInfo();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: `chief lease held by ${info?.holder_name ?? "unknown"}` })
              }
            ]
          };
        }
      }
      const prevName = currentName;
      if (joinName !== prevName) {
        stmts.insertAlias.run({ $old_name: prevName, $session_id: SESSION_ID, $now: now() });
      }
      stmts.updateSessionMeta.run({
        $id: SESSION_ID,
        $name: joinName,
        $role: joinRole,
        $domains: JSON.stringify(joinDomains),
        $now: now()
      });
      currentName = joinName;
      logEvent("session.joined", undefined, { name: joinName, role: joinRole, domains: joinDomains, rejoin: true });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              joined: true,
              name: joinName,
              role: joinRole,
              domains: joinDomains,
              previous_name: joinName !== prevName ? prevName : undefined
            })
          }
        ]
      };
    }
    case "tribe_health": {
      const threshold = now() - 30000;
      const silentThreshold = now() - 300000;
      const activeSessions = stmts.activeSessions.all();
      const pruned = [];
      for (const s of activeSessions) {
        if (s.pid === process.pid)
          continue;
        try {
          process.kill(s.pid, 0);
        } catch {
          pruned.push(s.name);
          const pruneTs = now();
          stmts.pruneSession.run({ $id: s.id, $now: pruneTs, $pruned_name: `${s.name}-pruned-${pruneTs}` });
        }
      }
      cleanupOldPrunedSessions();
      const liveSessions = stmts.activeSessions.all();
      const members = liveSessions.map((s) => {
        const alive = s.heartbeat > threshold;
        const lastMsg = db.prepare("SELECT ts FROM messages WHERE sender = $name ORDER BY ts DESC LIMIT 1").get({ $name: s.name });
        const lastMsgAge = lastMsg ? now() - lastMsg.ts : null;
        const warnings = [];
        if (!alive)
          warnings.push("heartbeat timeout \u2014 session may be dead");
        if (alive && lastMsgAge && lastMsgAge > silentThreshold) {
          warnings.push(`no message in ${Math.round(lastMsgAge / 60000)} min`);
        }
        if (!alive && !lastMsg)
          warnings.push("never sent a message");
        return {
          name: s.name,
          role: s.role,
          domains: JSON.parse(s.domains),
          alive,
          last_message: lastMsgAge ? `${Math.round(lastMsgAge / 60000)} min ago` : "never",
          warnings
        };
      });
      const unread = db.prepare(`
				SELECT m.recipient, COUNT(*) as count FROM messages m
				WHERE m.recipient != '*'
				AND NOT EXISTS (
					SELECT 1 FROM reads r
					JOIN sessions s ON r.session_id = s.id
					WHERE r.message_id = m.id AND s.name = m.recipient
				)
				GROUP BY m.recipient
			`).all();
      const stats = {
        messages: db.prepare("SELECT COUNT(*) as n FROM messages").get()?.n ?? 0,
        events: db.prepare("SELECT COUNT(*) as n FROM events").get()?.n ?? 0,
        reads: db.prepare("SELECT COUNT(*) as n FROM reads").get()?.n ?? 0
      };
      const result = { members, unread, stats, checked_at: new Date().toISOString() };
      if (pruned.length > 0)
        result.pruned = pruned;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    }
    case "tribe_reload": {
      const reason = a.reason ?? "manual reload";
      logEvent("session.reload", undefined, { name: currentName, reason });
      process.stderr.write(`[tribe] reloading: ${reason}
`);
      setTimeout(() => {
        cleanup();
        const args3 = process.argv.slice(1);
        process.stderr.write(`[tribe] exec: ${process.execPath} ${args3.join(" ")}
`);
        const child = Bun.spawn([process.execPath, ...args3], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          env: process.env
        });
        child.exited.then((code) => process.exit(code ?? 0));
      }, 100);
      return {
        content: [{ type: "text", text: JSON.stringify({ reloading: true, reason, pid: process.pid }) }]
      };
    }
    case "tribe_retro": {
      const sinceStr = a.since;
      let sinceMs;
      if (sinceStr) {
        try {
          sinceMs = parseDuration(sinceStr);
        } catch {
          return { content: [{ type: "text", text: JSON.stringify({ error: `Invalid duration: "${sinceStr}"` }) }] };
        }
      }
      const fmt = a.format ?? "markdown";
      const report = generateRetro(db, sinceMs);
      const text = fmt === "json" ? JSON.stringify(report, null, 2) : formatMarkdown(report);
      return { content: [{ type: "text", text }] };
    }
    case "tribe_leadership": {
      const info = getLeaseInfo();
      if (!info) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ leader: null, message: "No chief lease has been acquired" }) }
          ]
        };
      }
      const expiresIn = Math.max(0, Math.round((info.lease_until - Date.now()) / 1000));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              holder_name: info.holder_name,
              holder_id: info.holder_id,
              term: info.term,
              expires_in_seconds: expiresIn,
              expired: expiresIn === 0,
              acquired_at: new Date(info.acquired_at).toISOString()
            }, null, 2)
          }
        ]
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});
var polling = false;
async function pollMessages() {
  if (polling)
    return;
  polling = true;
  try {
    try {
      const cursor = stmts.getCursor.get({ $session_id: SESSION_ID });
      const lastSeq = cursor?.last_seq ?? 0;
      const rows = stmts.pollMessages.all({
        $last_seq: lastSeq,
        $name: currentName,
        $session_id: SESSION_ID
      });
      const incoming = rows.filter((r) => r.sender !== currentName);
      for (const msg of incoming) {
        const meta = {
          from: msg.sender,
          type: msg.type,
          message_id: msg.id
        };
        if (msg.bead_id)
          meta.bead = msg.bead_id;
        if (msg.ref)
          meta.ref = msg.ref;
        await mcp.notification({
          method: "notifications/claude/channel",
          params: { content: msg.content, meta }
        });
        stmts.markRead.run({ $message_id: msg.id, $session_id: SESSION_ID, $now: now() });
      }
      if (rows.length > 0) {
        const maxSeq = Math.max(...rows.map((r) => r.rowid));
        const maxTs = Math.max(...rows.map((r) => r.ts));
        stmts.upsertCursor.run({ $session_id: SESSION_ID, $ts: maxTs, $seq: maxSeq });
        if (incoming.length > 0) {
          stmts.updateLastDelivered.run({ $id: SESSION_ID, $ts: maxTs, $seq: maxSeq });
        }
      }
    } catch {}
  } finally {
    polling = false;
  }
}
registerSession();
cleanupOldPrunedSessions();
cleanupOldData();
tryInitialRename();
var heartbeatInterval = setInterval(sendHeartbeat, 1e4);
var pollInterval = setInterval(() => void pollMessages(), 1000);
var cleanupInterval = setInterval(cleanupOldData, 6 * 60 * 60 * 1000);
var pluginCtx = {
  sendMessage,
  hasChief() {
    const threshold = Date.now() - 30000;
    return !!db.prepare("SELECT name FROM sessions WHERE role = 'chief' AND heartbeat > ? AND pruned_at IS NULL").get(threshold);
  },
  hasRecentMessage(contentPrefix) {
    const since = Date.now() - 120000;
    return !!stmts.hasRecentMessage.get({ $prefix: contentPrefix, $since: since });
  },
  sessionName: currentName,
  sessionId: SESSION_ID,
  claudeSessionId: CLAUDE_SESSION_ID,
  triggerReload(reason) {
    logEvent("session.reload", undefined, { name: currentName, reason, auto: true });
    process.stderr.write(`[tribe] auto-reload: ${reason}
`);
    setTimeout(() => {
      cleanup();
      const args3 = process.argv.slice(1);
      const child = Bun.spawn([process.execPath, ...args3], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: process.env
      });
      child.exited.then((code) => process.exit(code ?? 0));
    }, 500);
  }
};
var plugins = args2["auto-report"] !== false ? [gitPlugin(), beadsPlugin({ beadsDir: BEADS_DIR })] : [];
var stopPlugins = loadPlugins(plugins, pluginCtx);
var cleaned = false;
function cleanup() {
  if (cleaned)
    return;
  cleaned = true;
  clearInterval(heartbeatInterval);
  clearInterval(pollInterval);
  clearInterval(cleanupInterval);
  stopPlugins();
  try {
    logEvent("session.left", undefined, { name: currentName });
    db.close();
  } catch {}
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
process.on("exit", cleanup);
await mcp.connect(new StdioServerTransport);
