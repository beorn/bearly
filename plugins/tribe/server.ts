#!/usr/bin/env bun
// @bun
var __require = import.meta.require;

// tools/tribe.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID as randomUUID3 } from "crypto";

// tools/lib/tribe/config.ts
import { existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { parseArgs } from "util";
function parseTribeArgs() {
  const { values } = parseArgs({
    options: {
      name: { type: "string", default: process.env.TRIBE_NAME },
      role: { type: "string", default: process.env.TRIBE_ROLE },
      domains: { type: "string", default: process.env.TRIBE_DOMAINS ?? "" },
      db: { type: "string", default: process.env.TRIBE_DB },
      "auto-report": { type: "boolean", default: (process.env.TRIBE_AUTO_REPORT ?? "1") === "1" }
    },
    strict: false
  });
  return values;
}
function parseSessionDomains(args) {
  return String(args.domains ?? "").split(",").filter(Boolean);
}
function findBeadsDir() {
  let dir = process.cwd();
  while (dir !== "/") {
    const candidate = resolve(dir, ".beads");
    if (existsSync(candidate))
      return candidate;
    dir = dirname(dir);
  }
  return null;
}
function resolveDbPath(args, beadsDir) {
  if (args.db)
    return String(args.db);
  if (process.env.TRIBE_DB)
    return process.env.TRIBE_DB;
  if (beadsDir)
    return resolve(beadsDir, "tribe.db");
  const xdgData = process.env.XDG_DATA_HOME ?? resolve(process.env.HOME ?? "~", ".local/share");
  const tribeDir = resolve(xdgData, "tribe");
  mkdirSync(tribeDir, { recursive: true });
  return resolve(tribeDir, "tribe.db");
}
function detectRole(db, args) {
  if (args.role)
    return args.role;
  const threshold = Date.now() - 30000;
  const liveChief = db.prepare("SELECT name FROM sessions WHERE role = 'chief' AND heartbeat > ?").get(threshold);
  return liveChief ? "member" : "chief";
}
function detectName(db, role, args) {
  if (args.name)
    return String(args.name);
  if (role === "chief")
    return "chief";
  const pidName = `member-${process.pid}`;
  const taken = db.prepare("SELECT id FROM sessions WHERE name = ? AND pruned_at IS NULL").get(pidName);
  if (!taken)
    return pidName;
  return `member-${process.pid}-${Math.random().toString(36).slice(2, 5)}`;
}
function resolveClaudeSessionId() {
  return process.env.CLAUDE_SESSION_ID ?? process.env.BD_ACTOR?.replace("claude:", "") ?? null;
}
function resolveClaudeSessionName() {
  return process.env.CLAUDE_SESSION_NAME ?? null;
}

// tools/lib/tribe/database.ts
import { Database } from "bun:sqlite";
function openDatabase(path) {
  const db = new Database(path, { create: true });
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
  db.run(`CREATE TABLE IF NOT EXISTS dedup (
		key        TEXT PRIMARY KEY,
		session_id TEXT NOT NULL,
		ts         INTEGER NOT NULL
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
function createStatements(db) {
  return {
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
    claimDedup: db.prepare("INSERT OR IGNORE INTO dedup (key, session_id, ts) VALUES ($key, $session_id, $ts)"),
    cleanupDedup: db.prepare("DELETE FROM dedup WHERE ts < $cutoff"),
    updateLastDelivered: db.prepare("UPDATE sessions SET last_delivered_ts = $ts, last_delivered_seq = $seq WHERE id = $id"),
    getLastDelivered: db.prepare("SELECT last_delivered_ts, last_delivered_seq FROM sessions WHERE id = $id"),
    activeSessions: db.prepare("SELECT id, name, role, domains, pid, cwd, claude_session_id, claude_session_name, started_at, heartbeat, pruned_at FROM sessions WHERE pruned_at IS NULL"),
    deleteOldPrunedSessions: db.prepare("DELETE FROM sessions WHERE pruned_at IS NOT NULL AND pruned_at < $cutoff")
  };
}

// tools/lib/tribe/lease.ts
var LEASE_DURATION_MS = 60000;
function acquireLease(db, id, name) {
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
function isLeaseHolder(db, id) {
  const row = db.prepare("SELECT holder_id FROM leadership WHERE role = 'chief' AND holder_id = $id AND lease_until > $now").get({ $id: id, $now: Date.now() });
  return !!row;
}
function getLeaseInfo(db) {
  return db.prepare("SELECT holder_name, holder_id, term, lease_until, acquired_at FROM leadership WHERE role = 'chief'").get();
}

// tools/lib/tribe/context.ts
function createTribeContext(opts) {
  let currentName = opts.initialName;
  return {
    db: opts.db,
    stmts: opts.stmts,
    sessionId: opts.sessionId,
    sessionRole: opts.sessionRole,
    domains: opts.domains,
    claudeSessionId: opts.claudeSessionId,
    claudeSessionName: opts.claudeSessionName,
    getName: () => currentName,
    setName: (name) => {
      currentName = name;
    }
  };
}

// tools/lib/tribe/session.ts
import { randomUUID as randomUUID2 } from "crypto";
import { existsSync as existsSync2, readFileSync } from "fs";
import { resolve as resolve2 } from "path";

// tools/lib/tribe/messaging.ts
import { randomUUID } from "crypto";
function sendMessage(ctx, recipient, content, type = "notify", bead_id, ref) {
  const id = randomUUID();
  ctx.stmts.insertMessage.run({
    $id: id,
    $type: type,
    $sender: ctx.getName(),
    $recipient: recipient,
    $content: content,
    $bead_id: bead_id ?? null,
    $ref: ref ?? null,
    $ts: Date.now()
  });
  return { id };
}
function logEvent(ctx, type, bead_id, data) {
  ctx.stmts.insertEvent.run({
    $id: randomUUID(),
    $type: type,
    $session: ctx.getName(),
    $bead_id: bead_id ?? null,
    $data: data ? JSON.stringify(data) : null,
    $ts: Date.now()
  });
}

// tools/lib/tribe/session.ts
function registerSession(ctx) {
  try {
    ctx.stmts.upsertSession.run({
      $id: ctx.sessionId,
      $name: ctx.getName(),
      $role: ctx.sessionRole,
      $domains: JSON.stringify(ctx.domains),
      $pid: process.pid,
      $cwd: process.cwd(),
      $claude_session_id: ctx.claudeSessionId,
      $claude_session_name: ctx.claudeSessionName,
      $now: Date.now()
    });
  } catch {
    const fallbackName = `${ctx.getName()}-${Math.random().toString(36).slice(2, 5)}`;
    process.stderr.write(`[tribe] name "${ctx.getName()}" taken, using "${fallbackName}"
`);
    ctx.setName(fallbackName);
    ctx.stmts.upsertSession.run({
      $id: ctx.sessionId,
      $name: ctx.getName(),
      $role: ctx.sessionRole,
      $domains: JSON.stringify(ctx.domains),
      $pid: process.pid,
      $cwd: process.cwd(),
      $claude_session_id: ctx.claudeSessionId,
      $claude_session_name: ctx.claudeSessionName,
      $now: Date.now()
    });
  }
  ctx.stmts.insertEvent.run({
    $id: randomUUID2(),
    $type: "session.joined",
    $session: ctx.getName(),
    $bead_id: null,
    $data: JSON.stringify({ name: ctx.getName(), role: ctx.sessionRole, domains: ctx.domains }),
    $ts: Date.now()
  });
  const cursor = ctx.stmts.getCursor.get({ $session_id: ctx.sessionId });
  if (!cursor) {
    let initialTs = 0;
    let initialSeq = 0;
    if (ctx.claudeSessionId) {
      const prior = ctx.db.prepare("SELECT last_delivered_ts, last_delivered_seq FROM sessions WHERE claude_session_id = $csid AND id != $id AND last_delivered_ts IS NOT NULL ORDER BY last_delivered_ts DESC LIMIT 1").get({ $csid: ctx.claudeSessionId, $id: ctx.sessionId });
      if (prior?.last_delivered_ts) {
        initialTs = prior.last_delivered_ts;
        initialSeq = prior.last_delivered_seq ?? 0;
        process.stderr.write(`[tribe] recovered cursor from prior session (claude_session_id): seq=${initialSeq}
`);
      }
    }
    if (initialSeq === 0) {
      const priorByPid = ctx.db.prepare("SELECT last_delivered_ts, last_delivered_seq FROM sessions WHERE pid = $pid AND id != $id AND last_delivered_seq IS NOT NULL AND last_delivered_seq > 0 ORDER BY heartbeat DESC LIMIT 1").get({ $pid: process.pid, $id: ctx.sessionId });
      if (priorByPid?.last_delivered_seq) {
        initialTs = priorByPid.last_delivered_ts ?? 0;
        initialSeq = priorByPid.last_delivered_seq;
        process.stderr.write(`[tribe] recovered cursor from prior session (PID match): seq=${initialSeq}
`);
      }
    }
    if (initialSeq === 0) {
      const latest = ctx.db.prepare("SELECT MAX(rowid) as max_seq FROM messages").get();
      if (latest?.max_seq) {
        initialSeq = latest.max_seq;
        initialTs = Date.now();
        process.stderr.write(`[tribe] no prior cursor found, skipping to latest: seq=${initialSeq}
`);
      }
    }
    if (initialSeq === 0 && initialTs > 0) {
      const maxRow = ctx.db.prepare("SELECT MAX(rowid) as max_rowid FROM messages WHERE ts <= $ts").get({ $ts: initialTs });
      initialSeq = maxRow?.max_rowid ?? 0;
      process.stderr.write(`[tribe] migrated ts cursor to seq=${initialSeq}
`);
    }
    ctx.stmts.upsertCursor.run({ $session_id: ctx.sessionId, $ts: initialTs, $seq: initialSeq });
  } else if (!cursor.last_seq) {
    const maxRow = ctx.db.prepare("SELECT MAX(rowid) as max_rowid FROM messages WHERE ts <= $ts").get({ $ts: cursor.last_read_ts });
    const migratedSeq = maxRow?.max_rowid ?? 0;
    ctx.stmts.upsertCursor.run({ $session_id: ctx.sessionId, $ts: cursor.last_read_ts, $seq: migratedSeq });
    process.stderr.write(`[tribe] migrated existing cursor to seq=${migratedSeq}
`);
  }
}
function resolveTranscriptPath(claudeSessionId) {
  if (!claudeSessionId)
    return null;
  const cwd = process.cwd();
  const projectKey = "-" + cwd.replace(/\//g, "-");
  const transcriptPath = resolve2(process.env.HOME ?? "~", ".claude/projects", projectKey, `${claudeSessionId}.jsonl`);
  return existsSync2(transcriptPath) ? transcriptPath : null;
}
function readTranscriptSlug(transcriptPath) {
  if (!transcriptPath)
    return null;
  try {
    const size = Bun.file(transcriptPath).size;
    if (size === 0)
      return null;
    const text = new TextDecoder().decode(new Uint8Array(readFileSync(transcriptPath).buffer.slice(Math.max(0, size - 4096))));
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
function tryInitialRename(ctx, transcriptPath) {
  if (!ctx.getName().startsWith("member-"))
    return;
  const slug = readTranscriptSlug(transcriptPath);
  if (!slug || slug === ctx.getName())
    return;
  const existing = ctx.stmts.checkNameTaken.get({ $name: slug, $session_id: ctx.sessionId });
  if (existing)
    return;
  const oldName = ctx.getName();
  ctx.stmts.insertAlias.run({ $old_name: oldName, $session_id: ctx.sessionId, $now: Date.now() });
  ctx.stmts.renameSession.run({ $new_name: slug, $session_id: ctx.sessionId });
  ctx.setName(slug);
  sendMessage(ctx, "*", `Member "${oldName}" is now "${slug}"`, "notify");
  logEvent(ctx, "session.renamed", undefined, { old_name: oldName, new_name: slug, source: "initial-slug" });
  process.stderr.write(`[tribe] initial name from /rename: ${oldName} \u2192 ${slug}
`);
}
function cleanupOldPrunedSessions(ctx) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const result = ctx.stmts.deleteOldPrunedSessions.run({ $cutoff: cutoff });
  if (result.changes > 0) {
    process.stderr.write(`[tribe] cleaned up ${result.changes} old pruned session(s)
`);
  }
}
function cleanupOldData(ctx) {
  const READS_TTL = 7 * 24 * 60 * 60 * 1000;
  const DATA_TTL = 30 * 24 * 60 * 60 * 1000;
  const now_ms = Date.now();
  const readsDel = ctx.db.prepare("DELETE FROM reads WHERE read_at < $cutoff").run({ $cutoff: now_ms - READS_TTL });
  const eventsDel = ctx.db.prepare("DELETE FROM events WHERE ts < $cutoff").run({ $cutoff: now_ms - DATA_TTL });
  const msgsDel = ctx.db.prepare("DELETE FROM messages WHERE ts < $cutoff").run({ $cutoff: now_ms - DATA_TTL });
  const aliasesDel = ctx.db.prepare("DELETE FROM aliases WHERE renamed_at < $cutoff").run({ $cutoff: now_ms - DATA_TTL });
  ctx.stmts.cleanupDedup.run({ $cutoff: now_ms - 24 * 60 * 60 * 1000 });
  const total = (readsDel.changes ?? 0) + (eventsDel.changes ?? 0) + (msgsDel.changes ?? 0) + (aliasesDel.changes ?? 0);
  if (total > 0) {
    process.stderr.write(`[tribe] cleanup: ${readsDel.changes} reads, ${eventsDel.changes} events, ${msgsDel.changes} msgs, ${aliasesDel.changes} aliases deleted
`);
  }
}
function sendHeartbeat(ctx) {
  const session = ctx.db.prepare("SELECT pruned_at FROM sessions WHERE id = ?").get(ctx.sessionId);
  if (session?.pruned_at) {
    logEvent(ctx, "session.rejoined", undefined, {
      name: ctx.getName(),
      role: ctx.sessionRole,
      domains: ctx.domains
    });
    process.stderr.write(`[tribe] ${ctx.getName()} rejoined tribe (was pruned)
`);
    registerSession(ctx);
    return;
  }
  ctx.stmts.heartbeat.run({ $id: ctx.sessionId, $now: Date.now() });
  if (ctx.sessionRole === "chief") {
    acquireLease(ctx.db, ctx.sessionId, ctx.getName());
  }
}

// tools/lib/tribe/validation.ts
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

// tools/tribe-retro.ts
import { Database as Database2 } from "bun:sqlite";
import { existsSync as existsSync3 } from "fs";
import { dirname as dirname2, resolve as resolve3 } from "path";
import { parseArgs as parseArgs2 } from "util";
var { values: args } = parseArgs2({
  options: {
    since: { type: "string", default: undefined },
    format: { type: "string", default: "markdown" },
    db: { type: "string", default: undefined }
  },
  strict: false
});
function findBeadsDir2() {
  let dir = process.cwd();
  while (dir !== "/") {
    const candidate = resolve3(dir, ".beads");
    if (existsSync3(candidate))
      return candidate;
    dir = dirname2(dir);
  }
  return resolve3(process.cwd(), ".beads");
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
  const dbPath = args.db ?? resolve3(findBeadsDir2(), "tribe.db");
  if (!existsSync3(dbPath)) {
    console.error(`No tribe database found at ${dbPath}`);
    process.exit(1);
  }
  const db = new Database2(dbPath, { readonly: true });
  db.run("PRAGMA busy_timeout = 5000");
  const sinceMs = args.since ? parseDuration(args.since) : undefined;
  const report = generateRetro(db, sinceMs);
  console.log(args.format === "json" ? JSON.stringify(report, null, 2) : formatMarkdown(report));
  db.close();
}
main();

// tools/lib/tribe/handlers.ts
function handleToolCall(ctx, name, a, opts) {
  switch (name) {
    case "tribe_send":
      return handleSend(ctx, a);
    case "tribe_broadcast":
      return handleBroadcast(ctx, a);
    case "tribe_sessions":
      return handleSessions(ctx, a);
    case "tribe_history":
      return handleHistory(ctx, a);
    case "tribe_rename":
      return handleRename(ctx, a, opts);
    case "tribe_join":
      return handleJoin(ctx, a);
    case "tribe_health":
      return handleHealth(ctx);
    case "tribe_reload":
      return handleReload(ctx, a, opts.cleanup);
    case "tribe_retro":
      return handleRetro(ctx, a);
    case "tribe_leadership":
      return handleLeadership(ctx);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
function handleSend(ctx, a) {
  const msgType = a.type ?? "notify";
  if ((msgType === "assign" || msgType === "verdict") && !isLeaseHolder(ctx.db, ctx.sessionId)) {
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
  const result = sendMessage(ctx, a.to, sanitized, msgType, a.bead, a.ref);
  logEvent(ctx, `message.sent.${msgType}`, a.bead, {
    to: a.to,
    message_id: result.id
  });
  return { content: [{ type: "text", text: JSON.stringify({ sent: true, id: result.id }) }] };
}
function handleBroadcast(ctx, a) {
  const sanitized = sanitizeMessage(a.message);
  const result = sendMessage(ctx, "*", sanitized, a.type ?? "notify", a.bead);
  logEvent(ctx, "message.broadcast", a.bead, { message_id: result.id });
  return { content: [{ type: "text", text: JSON.stringify({ sent: true, id: result.id }) }] };
}
function handleSessions(ctx, a) {
  const threshold = Date.now() - 30000;
  const rows = ctx.stmts.allSessions.all();
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
      const pruneTs = Date.now();
      ctx.stmts.pruneSession.run({ $id: r.id, $now: pruneTs, $pruned_name: `${r.name}-pruned-${pruneTs}` });
    }
  }
  const liveRows = a.all ? ctx.stmts.allSessions.all() : ctx.stmts.liveSessions.all({ $threshold: threshold });
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
    uptime_min: Math.round((Date.now() - r.started_at) / 60000),
    last_heartbeat_sec: Math.round((Date.now() - r.heartbeat) / 1000)
  }));
  const result = { sessions };
  if (dead.length > 0)
    result.pruned = dead;
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}
function handleHistory(ctx, a) {
  const who = a.with ?? ctx.getName();
  const limit = a.limit ?? 20;
  const rows = ctx.stmts.messageHistory.all({ $name: who, $limit: limit });
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
function handleRename(ctx, a, opts) {
  const newName = a.new_name;
  const nameError = validateName(newName);
  if (nameError) {
    return { content: [{ type: "text", text: JSON.stringify({ error: nameError }) }] };
  }
  const existing = ctx.stmts.checkNameTaken.get({ $name: newName, $session_id: ctx.sessionId });
  if (existing) {
    return { content: [{ type: "text", text: JSON.stringify({ error: `Name "${newName}" is already taken` }) }] };
  }
  const oldName = ctx.getName();
  ctx.stmts.insertAlias.run({ $old_name: oldName, $session_id: ctx.sessionId, $now: Date.now() });
  ctx.stmts.renameSession.run({ $new_name: newName, $session_id: ctx.sessionId });
  ctx.setName(newName);
  opts.setUserRenamed(true);
  sendMessage(ctx, "*", `Member "${oldName}" is now "${newName}"`, "notify");
  logEvent(ctx, "session.renamed", undefined, { old_name: oldName, new_name: newName });
  return {
    content: [{ type: "text", text: JSON.stringify({ renamed: true, old_name: oldName, new_name: newName }) }]
  };
}
function handleJoin(ctx, a) {
  const joinName = a.name;
  const joinRole = a.role ?? ctx.sessionRole;
  const joinDomains = a.domains ?? ctx.domains;
  const joinNameError = validateName(joinName);
  if (joinNameError) {
    return { content: [{ type: "text", text: JSON.stringify({ error: joinNameError }) }] };
  }
  const taken = ctx.stmts.checkNameTaken.get({ $name: joinName, $session_id: ctx.sessionId });
  if (taken) {
    return { content: [{ type: "text", text: JSON.stringify({ error: `Name "${joinName}" is already taken` }) }] };
  }
  if (joinRole === "chief") {
    const leased = acquireLease(ctx.db, ctx.sessionId, joinName);
    if (!leased) {
      const info = getLeaseInfo(ctx.db);
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
  const prevName = ctx.getName();
  if (joinName !== prevName) {
    ctx.stmts.insertAlias.run({ $old_name: prevName, $session_id: ctx.sessionId, $now: Date.now() });
  }
  ctx.stmts.updateSessionMeta.run({
    $id: ctx.sessionId,
    $name: joinName,
    $role: joinRole,
    $domains: JSON.stringify(joinDomains),
    $now: Date.now()
  });
  ctx.setName(joinName);
  logEvent(ctx, "session.joined", undefined, { name: joinName, role: joinRole, domains: joinDomains, rejoin: true });
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
function handleHealth(ctx) {
  const threshold = Date.now() - 30000;
  const silentThreshold = Date.now() - 300000;
  const activeSessions = ctx.stmts.activeSessions.all();
  const pruned = [];
  for (const s of activeSessions) {
    if (s.pid === process.pid)
      continue;
    try {
      process.kill(s.pid, 0);
    } catch {
      pruned.push(s.name);
      const pruneTs = Date.now();
      ctx.stmts.pruneSession.run({ $id: s.id, $now: pruneTs, $pruned_name: `${s.name}-pruned-${pruneTs}` });
    }
  }
  cleanupOldPrunedSessions(ctx);
  const liveSessions = ctx.stmts.activeSessions.all();
  const members = liveSessions.map((s) => {
    const alive = s.heartbeat > threshold;
    const lastMsg = ctx.db.prepare("SELECT ts FROM messages WHERE sender = $name ORDER BY ts DESC LIMIT 1").get({ $name: s.name });
    const lastMsgAge = lastMsg ? Date.now() - lastMsg.ts : null;
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
  const unread = ctx.db.prepare(`
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
    messages: ctx.db.prepare("SELECT COUNT(*) as n FROM messages").get()?.n ?? 0,
    events: ctx.db.prepare("SELECT COUNT(*) as n FROM events").get()?.n ?? 0,
    reads: ctx.db.prepare("SELECT COUNT(*) as n FROM reads").get()?.n ?? 0
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
function handleReload(ctx, a, cleanup) {
  const reason = a.reason ?? "manual reload";
  logEvent(ctx, "session.reload", undefined, { name: ctx.getName(), reason });
  process.stderr.write(`[tribe] reloading: ${reason}
`);
  setTimeout(() => {
    cleanup();
    const args2 = process.argv.slice(1);
    process.stderr.write(`[tribe] exec: ${process.execPath} ${args2.join(" ")}
`);
    const child = Bun.spawn([process.execPath, ...args2], {
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
function handleRetro(ctx, a) {
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
  const report = generateRetro(ctx.db, sinceMs);
  const text = fmt === "json" ? JSON.stringify(report, null, 2) : formatMarkdown(report);
  return { content: [{ type: "text", text }] };
}
function handleLeadership(ctx) {
  const info = getLeaseInfo(ctx.db);
  if (!info) {
    return {
      content: [{ type: "text", text: JSON.stringify({ leader: null, message: "No chief lease has been acquired" }) }]
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

// tools/lib/tribe/polling.ts
function createPoller(ctx, mcp) {
  let polling = false;
  return async function pollMessages() {
    if (polling)
      return;
    polling = true;
    try {
      try {
        const cursor = ctx.stmts.getCursor.get({ $session_id: ctx.sessionId });
        const lastSeq = cursor?.last_seq ?? 0;
        const rows = ctx.stmts.pollMessages.all({
          $last_seq: lastSeq,
          $name: ctx.getName(),
          $session_id: ctx.sessionId
        });
        const incoming = rows.filter((r) => r.sender !== ctx.getName());
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
          ctx.stmts.markRead.run({ $message_id: msg.id, $session_id: ctx.sessionId, $now: Date.now() });
        }
        if (rows.length > 0) {
          const maxSeq = Math.max(...rows.map((r) => r.rowid));
          const maxTs = Math.max(...rows.map((r) => r.ts));
          ctx.stmts.upsertCursor.run({ $session_id: ctx.sessionId, $ts: maxTs, $seq: maxSeq });
          if (incoming.length > 0) {
            ctx.stmts.updateLastDelivered.run({ $id: ctx.sessionId, $ts: maxTs, $seq: maxSeq });
          }
        }
      } catch {}
    } finally {
      polling = false;
    }
  };
}

// tools/lib/tribe/plugins.ts
import { existsSync as existsSync4, statSync, readFileSync as readFileSync2 } from "fs";
import { readFile } from "fs/promises";
import { resolve as resolve4 } from "path";
function beadsPlugin(opts = { beadsDir: null }) {
  return {
    name: "beads",
    available() {
      if (!opts.beadsDir)
        return false;
      const issuesPath = resolve4(opts.beadsDir, "backup/issues.jsonl");
      return existsSync4(issuesPath);
    },
    start(ctx) {
      if (!opts.beadsDir)
        return;
      const issuesPath = resolve4(opts.beadsDir, "backup/issues.jsonl");
      if (!existsSync4(issuesPath))
        return;
      let lastMtime = 0;
      const reportedStates = new Map;
      try {
        lastMtime = statSync(issuesPath).mtimeMs;
        for (const line of readFileSync2(issuesPath, "utf8").split(`
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
                if (ctx.claimDedup(`claimed:${entry.id}`)) {
                  ctx.sendMessage("chief", `Claimed: ${entry.id} \u2014 ${entry.title}`, "status", entry.id);
                }
              }
              if (isMyClaim && entry.status === "closed" && reportedStates.get(entry.id) !== "closed") {
                reportedStates.set(entry.id, "closed");
                if (ctx.claimDedup(`closed:${entry.id}`)) {
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
            if (ctx.claimDedup(`commit:${head}`)) {
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

// tools/lib/tribe/tools-list.ts
var TOOLS_LIST = [
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
];

// tools/tribe.ts
var args2 = parseTribeArgs();
var SESSION_DOMAINS = parseSessionDomains(args2);
var SESSION_ID = randomUUID3();
var CLAUDE_SESSION_ID = resolveClaudeSessionId();
var CLAUDE_SESSION_NAME = resolveClaudeSessionName();
var BEADS_DIR = findBeadsDir();
var DB_PATH = resolveDbPath(args2, BEADS_DIR);
var db = openDatabase(String(DB_PATH));
var SESSION_ROLE = detectRole(db, args2);
var SESSION_NAME = detectName(db, SESSION_ROLE, args2);
var stmts = createStatements(db);
var ctx = createTribeContext({
  db,
  stmts,
  sessionId: SESSION_ID,
  sessionRole: SESSION_ROLE,
  initialName: SESSION_NAME,
  domains: SESSION_DOMAINS,
  claudeSessionId: CLAUDE_SESSION_ID,
  claudeSessionName: CLAUDE_SESSION_NAME
});
process.stderr.write(`[tribe] ${ctx.getName()} (${SESSION_ROLE}) joining tribe at ${DB_PATH}
`);
process.stderr.write(`[tribe] claude_session_id=${CLAUDE_SESSION_ID ?? "none"}
`);
if (SESSION_DOMAINS.length > 0) {
  process.stderr.write(`[tribe] domains: ${SESSION_DOMAINS.join(", ")}
`);
}
if (SESSION_ROLE === "chief") {
  const leased = acquireLease(db, SESSION_ID, SESSION_NAME);
  process.stderr.write(`[tribe] leader lease: ${leased ? "acquired" : "held by another"}
`);
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
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS_LIST }));
var userRenamed = false;
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: toolArgs } = req.params;
  const a = toolArgs ?? {};
  return handleToolCall(ctx, name, a, {
    cleanup,
    userRenamed,
    setUserRenamed: (v) => {
      userRenamed = v;
    }
  });
});
registerSession(ctx);
cleanupOldPrunedSessions(ctx);
cleanupOldData(ctx);
var transcriptPath = resolveTranscriptPath(CLAUDE_SESSION_ID);
tryInitialRename(ctx, transcriptPath);
var heartbeatInterval = setInterval(() => sendHeartbeat(ctx), 1e4);
var pollMessages = createPoller(ctx, mcp);
var pollInterval = setInterval(() => void pollMessages(), 1000);
var cleanupDataInterval = setInterval(() => cleanupOldData(ctx), 6 * 60 * 60 * 1000);
var pluginCtx = {
  sendMessage(to, content, type, beadId) {
    sendMessage(ctx, to, content, type, beadId);
  },
  hasChief() {
    const threshold = Date.now() - 30000;
    return !!db.prepare("SELECT name FROM sessions WHERE role = 'chief' AND heartbeat > ? AND pruned_at IS NULL").get(threshold);
  },
  hasRecentMessage(contentPrefix) {
    const since = Date.now() - 300000;
    return !!stmts.hasRecentMessage.get({ $prefix: contentPrefix, $since: since });
  },
  claimDedup(key) {
    const result = stmts.claimDedup.run({ $key: key, $session_id: SESSION_ID, $ts: Date.now() });
    return result.changes > 0;
  },
  sessionName: ctx.getName(),
  sessionId: SESSION_ID,
  claudeSessionId: CLAUDE_SESSION_ID,
  triggerReload(reason) {
    logEvent(ctx, "session.reload", undefined, { name: ctx.getName(), reason, auto: true });
    process.stderr.write(`[tribe] auto-reload: ${reason}
`);
    setTimeout(() => {
      cleanup();
      const argv = process.argv.slice(1);
      const child = Bun.spawn([process.execPath, ...argv], {
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
  clearInterval(cleanupDataInterval);
  stopPlugins();
  try {
    logEvent(ctx, "session.left", undefined, { name: ctx.getName() });
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
