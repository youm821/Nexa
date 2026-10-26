#!/usr/bin/env node
/**
 * modbot.mjs - a moderation bot for Yapper, written for Node.js 18+.
 * No npm packages needed.
 *
 * It talks to Yapper's bot HTTP API directly (the same endpoints the YapPy
 * Python library uses), so none of YapPy's bugs apply here.
 *
 * Features
 *   - Auto-mod: banned words, spam, mass mentions, link filter
 *   - Warning system with automatic timeout escalation
 *   - Commands: warn, warnings, clearwarns, timeout, ban, unban,
 *               addword, delword, words, links, allowdomain, setlog, modhelp
 *   - Optional mod-log channel
 *   - Settings and warnings saved in modbot_data.json (same format as the
 *     Python version, so you can switch between them)
 *
 * Run:  node modbot.mjs     (needs TOKEN in the environment or a .env file)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startWeb, claimCode } from "./web.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// --------------------------------------------------------------------------
// Settings you can tweak
// --------------------------------------------------------------------------
const PREFIX = "!";
const SPAM_MESSAGES = 5;          // this many messages...
const SPAM_SECONDS = 6;           // ...within this many seconds counts as spam
const MAX_MENTIONS = 5;           // more mentions than this in one message is removed
const MAX_TIMEOUT_MINUTES = 10080; // 7 days
// When a user reaches this many warnings, they are timed out for N minutes.
const ESCALATION = { 3: 10, 5: 60 };

const GUILD_TTL_MS = 60_000;      // how long server/role info is cached
const MEMBER_TTL_MS = 300_000;    // how long member info is cached (auto-mod only)

const BASE_URL = process.env.YAPPER_API_URL ?? "https://www.yapper.website/api/bot/v1";

// --------------------------------------------------------------------------
// Tiny helpers: logging, .env loading
// --------------------------------------------------------------------------
const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => console.log(stamp(), ...a);
const logErr = (...a) => console.error(stamp(), "ERROR", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}
loadEnv(path.join(HERE, ".env"));
loadEnv(path.join(process.cwd(), ".env"));

const TOKEN = process.env.TOKEN;
const stats = { messages: 0, commands: 0, startedAt: Date.now() };
const PUBLIC_URL = process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? "";

// --------------------------------------------------------------------------
// Storage (one JSON file; fine for small/medium servers)
// --------------------------------------------------------------------------
const DATA_FILE = process.env.MODBOT_DATA ?? path.join(HERE, "modbot_data.json");
let data = {};
try {
  data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
} catch (e) {
  if (e.code !== "ENOENT") logErr(`Couldn't read ${DATA_FILE}, starting fresh:`, e.message);
}

function guildCfg(gid) {
  const g = (data[gid] ??= {});
  g.banned_words ??= [];
  g.log_channel ??= null;
  g.block_links ??= false;
  g.allowed_domains ??= [];
  g.warnings ??= {};
  g.prefix ??= null;
  g.custom_commands ??= {};
  g.blacklisted ??= false;
  return g;
}

function save() {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// --------------------------------------------------------------------------
// Yapper API client
// --------------------------------------------------------------------------
class ApiError extends Error {
  constructor(method, p, status, message) {
    super(`${method} ${p} failed (${status}): ${message}`);
    this.status = status;
  }
}

async function api(method, p, body, tries = 3) {
  const res = await fetch(BASE_URL + p, {
    method,
    headers: { Authorization: `Bot ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(40_000),
  });

  // Some endpoints may answer with an empty body; that's fine.
  const text = await res.text();
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch { json = null; }
  }

  if (!res.ok) {
    const retryAfter = Number(res.headers.get("Retry-After") || 0);
    const busy = res.status === 503 && json && "retry_after" in json;
    if ((res.status === 429 || busy) && retryAfter > 0 && retryAfter <= 60 && tries > 1) {
      const delay = retryAfter * 1000 * (1 + Math.random() * 0.5);
      log(`${busy ? "Server busy" : "Rate limited"} on ${method} ${p}, retrying in ${(delay / 1000).toFixed(1)}s`);
      await sleep(delay);
      return api(method, p, body, tries - 1);
    }
    throw new ApiError(method, p, res.status, json?.error ?? res.statusText);
  }
  return json;
}

const send = (channelId, content, replyTo = null) =>
  api("POST", `/channels/${channelId}/messages`, {
    content, embeds: [], components: [], reply_to: replyTo,
  });

const deleteMessage = (channelId, messageId) =>
  api("DELETE", `/channels/${channelId}/messages/${messageId}`);

const doTimeout = (guildId, userId, minutes, reason) =>
  api("POST", `/servers/${guildId}/timeouts`, { user_id: userId, minutes, reason });

const doBan = (guildId, userId) =>
  api("POST", `/servers/${guildId}/bans`, { user_id: userId });

const doUnban = (guildId, userId) =>
  api("DELETE", `/servers/${guildId}/bans/${userId}`);

// --------------------------------------------------------------------------
// Caches (channels, servers + roles, members)
// --------------------------------------------------------------------------
const channels = new Map();
const guilds = new Map();
const members = new Map();
const inflight = new Map();

// Concurrent lookups of the same thing share one request.
function once(key, fn) {
  if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key)));
  return inflight.get(key);
}

async function getChannel(id) {
  id = String(id);
  if (channels.has(id)) return channels.get(id);
  return once(`channel:${id}`, async () => {
    const c = (await api("GET", `/channels/${id}`)).channel;
    channels.set(id, c);
    return c;
  });
}

async function getGuild(id, fresh = false) {
  id = String(id);
  const cached = guilds.get(id);
  if (cached && !fresh && Date.now() - cached.at < GUILD_TTL_MS) return cached;
  return once(`guild:${id}:${fresh}`, async () => {
    const [server, rolesData] = await Promise.all([
      api("GET", `/servers/${id}`),
      api("GET", `/servers/${id}/roles`),
    ]);
    const roles = new Map();
    for (const r of rolesData.roles ?? []) roles.set(String(r.id), r);
    const guild = {
      id,
      name: server.server.name,
      ownerId: String(server.server.owner_id),
      roles,
      at: Date.now(),
    };
    guilds.set(id, guild);
    return guild;
  });
}

async function getMember(guild, userId, fresh = false) {
  userId = String(userId);
  const key = `${guild.id}:${userId}`;
  const cached = members.get(key);
  if (cached && !fresh && Date.now() - cached.at < MEMBER_TTL_MS) return cached.member;
  return once(`member:${key}:${fresh}`, async () => {
    const d = (await api("GET", `/servers/${guild.id}/members/${userId}`)).member;
    const member = {
      id: userId,
      name: d.username,
      displayName: d.nickname || d.display_name || d.username,
      roleIds: (d.roles ?? []).map(String),
    };
    members.set(key, { member, at: Date.now() });
    return member;
  });
}

// --------------------------------------------------------------------------
// Permissions
// --------------------------------------------------------------------------
const isOwner = (member, guild) => guild.ownerId === member.id;

const hasPerm = (member, guild, perm) =>
  member.roleIds.some((id) => {
    const r = guild.roles.get(id);
    return r && (r[perm] === true || r.perms?.[perm] === true);
  });

/** Server owner, or any role with manage_messages / manage_server. */
const canModerate = (member, guild) =>
  isOwner(member, guild) || hasPerm(member, guild, "manage_messages") || hasPerm(member, guild, "manage_server");

/** Server owner, or any role with manage_server. */
const canManage = (member, guild) =>
  isOwner(member, guild) || hasPerm(member, guild, "manage_server");

/** Checks the command author's permissions (re-fetched, so role changes count). */
async function guard(ctx, level) {
  try {
    ctx.guild = await getGuild(ctx.guild.id, true);
    ctx.author = await getMember(ctx.guild, ctx.author.id, true);
  } catch (e) {
    logErr("Fresh permission lookup failed, using cached data:", e.message);
  }
  const ok = level === "manage" ? canManage(ctx.author, ctx.guild) : canModerate(ctx.author, ctx.guild);
  if (!ok) await ctx.reply("You don't have permission to use that command.");
  return ok;
}

/** Returns the member to act on, or null (after replying why not). */
async function resolveTarget(ctx, userId) {
  if (userId === String(me.id)) { await ctx.reply("I can't moderate myself."); return null; }
  if (userId === ctx.author.id) { await ctx.reply("You can't do that to yourself."); return null; }
  let target;
  try {
    target = await getMember(ctx.guild, userId, true);
  } catch {
    await ctx.reply("That user isn't in this server.");
    return null;
  }
  if (isOwner(target, ctx.guild)) { await ctx.reply("You can't moderate the server owner."); return null; }
  if (canModerate(target, ctx.guild) && !isOwner(ctx.author, ctx.guild)) {
    await ctx.reply("You can't moderate another moderator.");
    return null;
  }
  return target;
}

// --------------------------------------------------------------------------
// Warnings + mod log
// --------------------------------------------------------------------------
async function modLog(guild, text) {
  const cid = guildCfg(guild.id).log_channel;
  if (!cid) return;
  try {
    await send(cid, text);
  } catch (e) {
    logErr("Couldn't write to the mod-log channel:", e.message);
  }
}

async function addWarning(guild, channelId, userId, reason, moderator) {
  const cfg = guildCfg(guild.id);
  const warns = (cfg.warnings[userId] ??= []);
  warns.push({ reason, mod: moderator, time: Math.floor(Date.now() / 1000) });
  save();
  const count = warns.length;

  const msg = `<@${userId}> has been warned (${count} total). Reason: ${reason}`;
  await send(channelId, msg);
  await modLog(guild, `[warn] ${msg} - by ${moderator}`);

  const minutes = ESCALATION[count];
  if (minutes) {
    try {
      await doTimeout(guild.id, userId, minutes, `Reached ${count} warnings`);
      const note = `<@${userId}> was timed out for ${minutes} minutes (reached ${count} warnings).`;
      await send(channelId, note);
      await modLog(guild, `[timeout] ${note}`);
    } catch (e) {
      logErr("Auto-timeout failed:", e.message);
      await modLog(guild, `[error] Couldn't auto-timeout <@${userId}> at ${count} warnings.`);
    }
  }
}

// --------------------------------------------------------------------------
// Auto-moderation
// --------------------------------------------------------------------------
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const URL_RE = /(?:https?:\/\/|www\.)([^\s/<>]+)/gi;

function findBannedWord(content, words) {
  const text = content.replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, "").toLowerCase();
  for (const w of words) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(w)}(?![\\p{L}\\p{N}_])`, "u");
    if (re.test(text)) return w;
  }
  return null;
}

function findBadLink(content, cfg) {
  if (!cfg.block_links) return null;
  for (const m of content.matchAll(URL_RE)) {
    const host = m[1].toLowerCase().split(":")[0];
    const allowed = cfg.allowed_domains.some((d) => host === d || host.endsWith("." + d));
    if (!allowed) return host;
  }
  return null;
}

const recent = new Map();
function isSpam(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  const q = recent.get(key) ?? [];
  q.push(now);
  while (q.length > SPAM_MESSAGES) q.shift();
  recent.set(key, q);
  if (q.length >= SPAM_MESSAGES && now - q[0] <= SPAM_SECONDS * 1000) {
    recent.delete(key);
    return true;
  }
  return false;
}
setInterval(() => {
  const cutoff = Date.now() - SPAM_SECONDS * 1000;
  for (const [k, q] of recent) if (q[q.length - 1] < cutoff) recent.delete(k);
}, 60_000).unref();

/** Returns true if the message is fine, false if it was removed. */
async function automod(ctx) {
  if (canModerate(ctx.author, ctx.guild)) return true; // moderators are exempt

  const cfg = guildCfg(ctx.guild.id);
  const content = ctx.content;

  let reason = null;
  if (findBannedWord(content, cfg.banned_words)) {
    reason = "Used a banned word";
  } else {
    const host = findBadLink(content, cfg);
    if (host) reason = `Posted a link that isn't allowed (${host})`;
    else if ((content.match(/<@/g) ?? []).length > MAX_MENTIONS) reason = "Mass mentioning";
    else if (isSpam(ctx.guild.id, ctx.author.id)) reason = "Spamming";
  }
  if (reason === null) return true;

  try {
    await ctx.del();
  } catch (e) {
    logErr("Couldn't delete a message (does the bot have permission?):", e.message);
  }
  await addWarning(ctx.guild, ctx.channelId, ctx.author.id, `[auto] ${reason}`, "AutoMod");
  return false;
}

// --------------------------------------------------------------------------
// Command parsing helpers
// --------------------------------------------------------------------------
class UsageError extends Error {}

/** Splits off the first whitespace-separated token. */
function takeToken(s) {
  const m = s.trimStart().match(/^(\S+)\s*([\s\S]*)$/);
  return m ? [m[1], m[2]] : [null, ""];
}

/** Accepts <@123>, <@!123> or a bare id. Role mentions (<@&..>) are rejected. */
function parseId(tok, kind = "user") {
  if (!tok) return null;
  const re = kind === "channel" ? /^<#([^\s>]+)>$/ : /^<@!?([^\s>&][^\s>]*)>$/;
  const m = tok.match(re);
  if (m) return m[1];
  return /^[\w-]+$/.test(tok) ? tok : null;
}

function parseBool(tok) {
  const w = (tok ?? "").toLowerCase();
  if (["on", "true", "yes", "y", "1"].includes(w)) return true;
  if (["off", "false", "no", "n", "0"].includes(w)) return false;
  return null;
}

const reasonOf = (s) => s.trim() || "No reason given";

// --------------------------------------------------------------------------
// Commands
// --------------------------------------------------------------------------
const commands = new Map();
function command(name, usage, description, handler) {
  commands.set(name, { name, usage, description, handler });
}

command("warn", "warn <user> [reason]", "Warn a user", async (ctx, rest) => {
  if (!(await guard(ctx, "mod"))) return;
  const [tok, reason] = takeToken(rest);
  const uid = parseId(tok);
  if (!uid) throw new UsageError();
  const target = await resolveTarget(ctx, uid);
  if (!target) return;
  await addWarning(ctx.guild, ctx.channelId, target.id, reasonOf(reason), ctx.author.name);
});

command("warnings", "warnings <user>", "Show a user's warnings", async (ctx, rest) => {
  if (!(await guard(ctx, "mod"))) return;
  const uid = parseId(takeToken(rest)[0]);
  if (!uid) throw new UsageError();
  const warns = guildCfg(ctx.guild.id).warnings[uid] ?? [];
  if (!warns.length) return void (await ctx.reply(`<@${uid}> has no warnings.`));
  const start = Math.max(0, warns.length - 10);
  const lines = [`<@${uid}> has ${warns.length} warning(s):`];
  warns.slice(start).forEach((w, i) => {
    const when = new Date(w.time * 1000).toISOString().slice(0, 10);
    lines.push(`${start + i + 1}. ${w.reason} (by ${w.mod}, ${when})`);
  });
  await ctx.reply(lines.join("\n"));
});

command("clearwarns", "clearwarns <user>", "Clear all of a user's warnings", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  const uid = parseId(takeToken(rest)[0]);
  if (!uid) throw new UsageError();
  delete guildCfg(ctx.guild.id).warnings[uid];
  save();
  await ctx.reply(`Cleared all warnings for <@${uid}>.`);
  await modLog(ctx.guild, `[clearwarns] <@${uid}> cleared by ${ctx.author.name}`);
});

command("timeout", "timeout <user> <minutes> [reason]", "Time a user out", async (ctx, rest) => {
  if (!(await guard(ctx, "mod"))) return;
  const [uTok, r1] = takeToken(rest);
  const [mTok, reason] = takeToken(r1);
  const uid = parseId(uTok);
  if (!uid || !/^\d+$/.test(mTok ?? "")) throw new UsageError();
  const minutes = parseInt(mTok, 10);
  if (minutes < 1 || minutes > MAX_TIMEOUT_MINUTES) {
    return void (await ctx.reply(`Minutes must be between 1 and ${MAX_TIMEOUT_MINUTES}.`));
  }
  const target = await resolveTarget(ctx, uid);
  if (!target) return;
  const why = reasonOf(reason);
  try {
    await doTimeout(ctx.guild.id, target.id, minutes, why);
  } catch (e) {
    logErr("timeout failed:", e.message);
    return void (await ctx.reply(`Couldn't time them out: ${e.message}`));
  }
  const note = `<@${target.id}> was timed out for ${minutes} minutes. Reason: ${why}`;
  await ctx.reply(note);
  await modLog(ctx.guild, `[timeout] ${note} - by ${ctx.author.name}`);
});

command("ban", "ban <user> [reason]", "Ban a user", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  const [tok, reason] = takeToken(rest);
  const uid = parseId(tok);
  if (!uid) throw new UsageError();
  const target = await resolveTarget(ctx, uid);
  if (!target) return;
  const why = reasonOf(reason);
  try {
    await doBan(ctx.guild.id, target.id);
  } catch (e) {
    logErr("ban failed:", e.message);
    return void (await ctx.reply(`Couldn't ban them: ${e.message}`));
  }
  const note = `${target.displayName} was banned. Reason: ${why}`;
  await ctx.reply(note);
  await modLog(ctx.guild, `[ban] ${note} - by ${ctx.author.name}`);
});

command("unban", "unban <user id>", "Unban a user", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  const uid = parseId(takeToken(rest)[0]);
  if (!uid) throw new UsageError();
  try {
    await doUnban(ctx.guild.id, uid);
  } catch (e) {
    logErr("unban failed:", e.message);
    return void (await ctx.reply(`Couldn't unban that user: ${e.message}`));
  }
  await ctx.reply(`Unbanned ${uid}.`);
  await modLog(ctx.guild, `[unban] ${uid} unbanned by ${ctx.author.name}`);
});

command("addword", "addword <word>", "Add a banned word", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  const word = takeToken(rest)[0];
  if (!word) throw new UsageError();
  const cfg = guildCfg(ctx.guild.id);
  const w = word.toLowerCase();
  if (!cfg.banned_words.includes(w)) {
    cfg.banned_words.push(w);
    save();
  }
  await ctx.reply("Added to the banned word list.");
  try { await ctx.del(); } catch { /* don't leave the word sitting in chat */ }
});

command("delword", "delword <word>", "Remove a banned word", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  const word = takeToken(rest)[0]?.toLowerCase();
  if (!word) throw new UsageError();
  const cfg = guildCfg(ctx.guild.id);
  const i = cfg.banned_words.indexOf(word);
  if (i === -1) return void (await ctx.reply("That word isn't on the list."));
  cfg.banned_words.splice(i, 1);
  save();
  await ctx.reply("Removed from the banned word list.");
});

command("words", "words", "Show how many words are banned", async (ctx) => {
  if (!(await guard(ctx, "manage"))) return;
  const n = guildCfg(ctx.guild.id).banned_words.length;
  await ctx.reply(`${n} banned word(s). (The list itself isn't shown in chat.)`);
});

command("links", "links on|off", "Turn link blocking on or off", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  const on = parseBool(takeToken(rest)[0]);
  if (on === null) throw new UsageError();
  guildCfg(ctx.guild.id).block_links = on;
  save();
  await ctx.reply(`Link blocking is now ${on ? "ON" : "OFF"}.`);
});

command("allowdomain", "allowdomain <domain>", "Allow a domain when links are blocked", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  const tok = takeToken(rest)[0];
  if (!tok) throw new UsageError();
  const d = tok.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  const cfg = guildCfg(ctx.guild.id);
  if (!cfg.allowed_domains.includes(d)) {
    cfg.allowed_domains.push(d);
    save();
  }
  await ctx.reply(`Links to ${d} are now allowed.`);
});

command("setlog", "setlog <#channel>", "Set the mod-log channel", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  const cid = parseId(takeToken(rest)[0], "channel");
  if (!cid) throw new UsageError();
  try {
    await getChannel(cid);
  } catch {
    return void (await ctx.reply("I couldn't find that channel."));
  }
  guildCfg(ctx.guild.id).log_channel = cid;
  save();
  await ctx.reply(`Mod log set to <#${cid}>.`);
});

command("modhelp", "modhelp", "List all commands", async (ctx) => {
  const p = ctx.prefix ?? PREFIX;
  const custom = Object.keys(guildCfg(ctx.guild.id).custom_commands);
  await ctx.reply(
    "**Everyone**\n" +
    `${p}ping | ${p}serverinfo | ${p}userinfo [@user] | ${p}8ball <q> | ${p}coinflip | ${p}roll [sides] | ${p}choose a, b, c | ${p}dashboard\n` +
    "**Moderators**\n" +
    `${p}warn @user [reason] | ${p}warnings @user | ${p}removewarn @user <n> | ${p}timeout @user <minutes> [reason]\n` +
    "**Server managers**\n" +
    `${p}ban @user [reason] | ${p}unban <id> | ${p}clearwarns @user | ${p}say <text>\n` +
    `${p}addword <w> | ${p}delword <w> | ${p}words | ${p}links on|off | ${p}allowdomain <d> | ${p}setlog #channel\n` +
    `${p}setprefix <p> | ${p}addcmd <name> <text> | ${p}delcmd <name> | ${p}link <code>` +
    (custom.length ? `\n**Custom:** ${custom.map((c) => p + c).join(" ")}` : "")
  );
});

command("ping", "ping", "Check the bot is alive", async (ctx) => { await ctx.reply("Pong!"); });

command("serverinfo", "serverinfo", "Show server info", async (ctx) => {
  const g = await getGuild(ctx.guild.id, true);
  await ctx.reply(`**${g.name}**\nOwner: <@${g.ownerId}>\nRoles: ${g.roles.size}\nWarned users: ${Object.keys(guildCfg(g.id).warnings).length}`);
});

command("userinfo", "userinfo [user]", "Show info about a user", async (ctx, rest) => {
  const uid = parseId(takeToken(rest)[0]) ?? ctx.author.id;
  let m;
  try { m = await getMember(ctx.guild, uid, true); } catch { return void (await ctx.reply("That user isn't in this server.")); }
  const w = (guildCfg(ctx.guild.id).warnings[uid] ?? []).length;
  await ctx.reply(`**${m.displayName}** (${m.name})\nID: ${m.id}\nRoles: ${m.roleIds.length}\nWarnings: ${w}`);
});

const EIGHT = ["Yes.", "No.", "Maybe.", "Definitely.", "Ask again later.", "Doubtful.", "Without a doubt.", "I wouldn't count on it."];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
command("8ball", "8ball <question>", "Ask the magic 8-ball", async (ctx, rest) => {
  if (!rest.trim()) throw new UsageError();
  await ctx.reply(`:8ball: ${pick(EIGHT)}`);
});
command("coinflip", "coinflip", "Flip a coin", async (ctx) => { await ctx.reply(pick(["Heads!", "Tails!"])); });
command("roll", "roll [sides]", "Roll a die", async (ctx, rest) => {
  const n = parseInt(takeToken(rest)[0] ?? "6", 10);
  if (!(n >= 2 && n <= 1000)) throw new UsageError();
  await ctx.reply(`You rolled a ${1 + Math.floor(Math.random() * n)} (1-${n}).`);
});
command("choose", "choose a, b, c", "Pick one option", async (ctx, rest) => {
  const opts = rest.split(",").map((x) => x.trim()).filter(Boolean);
  if (opts.length < 2) throw new UsageError();
  await ctx.reply(`I choose: ${pick(opts)}`);
});

command("say", "say <text>", "Make the bot say something", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  if (!rest.trim()) throw new UsageError();
  try { await ctx.del(); } catch {}
  await send(ctx.channelId, rest.trim().slice(0, 1500));
});

command("removewarn", "removewarn <user> <number>", "Remove one warning", async (ctx, rest) => {
  if (!(await guard(ctx, "mod"))) return;
  const [u, r1] = takeToken(rest);
  const uid = parseId(u);
  const n = parseInt(takeToken(r1)[0] ?? "", 10);
  if (!uid || !(n >= 1)) throw new UsageError();
  const warns = guildCfg(ctx.guild.id).warnings[uid] ?? [];
  if (n > warns.length) return void (await ctx.reply("They don't have a warning with that number."));
  warns.splice(n - 1, 1);
  if (!warns.length) delete guildCfg(ctx.guild.id).warnings[uid];
  save();
  await ctx.reply(`Removed warning #${n} from <@${uid}>.`);
  await modLog(ctx.guild, `[removewarn] #${n} removed from <@${uid}> by ${ctx.author.name}`);
});

command("setprefix", "setprefix <prefix>", "Change this server's prefix", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  const p = takeToken(rest)[0];
  if (!p || p.length > 3) throw new UsageError();
  guildCfg(ctx.guild.id).prefix = p;
  save();
  await ctx.reply(`Prefix is now \`${p}\``);
});

command("addcmd", "addcmd <name> <text>", "Create a custom command", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  const [name, text] = takeToken(rest);
  const n = name?.toLowerCase();
  if (!n || !text.trim() || !/^[a-z0-9_-]{1,20}$/.test(n)) throw new UsageError();
  if (commands.has(n)) return void (await ctx.reply("That name is used by a built-in command."));
  const cc = guildCfg(ctx.guild.id).custom_commands;
  if (Object.keys(cc).length >= 50 && !(n in cc)) return void (await ctx.reply("Limit of 50 custom commands reached."));
  cc[n] = text.trim().slice(0, 500);
  save();
  await ctx.reply(`Created \`${ctx.prefix}${n}\`.`);
});

command("delcmd", "delcmd <name>", "Delete a custom command", async (ctx, rest) => {
  if (!(await guard(ctx, "manage"))) return;
  const n = takeToken(rest)[0]?.toLowerCase();
  if (!n) throw new UsageError();
  const cc = guildCfg(ctx.guild.id).custom_commands;
  if (!(n in cc)) return void (await ctx.reply("No custom command with that name."));
  delete cc[n];
  save();
  await ctx.reply(`Deleted \`${n}\`.`);
});

command("dashboard", "dashboard", "How to open the web dashboard", async (ctx) => {
  const url = PUBLIC_URL || "the Nexora website";
  await ctx.reply(`Manage this server at ${url}\n1. Click **Log in** and you'll get a code.\n2. Type \`${ctx.prefix}link <code>\` here (you need the Manage Server permission).`);
});

command("link", "link <code>", "Link the web dashboard to this server", async (ctx, rest) => {
  try { await ctx.del(); } catch {}
  if (!(await guard(ctx, "manage"))) return;
  const code = takeToken(rest)[0];
  if (!code) throw new UsageError();
  const ok = claimCode(code, ctx.guild.id, ctx.author.id);
  await ctx.reply(ok ? "Linked! Go back to the website tab." : "That code is wrong or expired. Get a fresh one from the website.");
});

async function runCommand(ctx) {
  const cfg = guildCfg(ctx.guild.id);
  const prefix = cfg.prefix || PREFIX;
  ctx.prefix = prefix;
  if (!ctx.content.startsWith(prefix)) return;
  const [name, rest] = takeToken(ctx.content.slice(prefix.length));
  const cmd = name && commands.get(name.toLowerCase());
  const custom = name && cfg.custom_commands[name.toLowerCase()];
  if (!cmd && custom) { stats.commands++; return void (await ctx.reply(custom)); }
  if (!cmd) return; // unknown commands are ignored
  stats.commands++;
  try {
    await cmd.handler(ctx, rest);
  } catch (e) {
    if (e instanceof UsageError) {
      await ctx.reply(`Usage: \`${prefix}${cmd.usage}\``);
    } else {
      logErr(`Command '${cmd.name}' failed:`, e);
    }
  }
}

// --------------------------------------------------------------------------
// Event handling + main loop
// --------------------------------------------------------------------------
let me = null;

async function handleMessage(ev) {
  const d = ev.data;
  if (ev.author_bot || String(d.author_id) === String(me.id)) return;

  const channel = await getChannel(d.channel_id);
  if (!channel.server_id) return; // not a server channel
  const guild = await getGuild(channel.server_id);
  const gc = guildCfg(guild.id);
  if (gc.name !== guild.name) { gc.name = guild.name; save(); }
  gc.last_seen = Date.now();
  stats.messages++;
  if (gc.blacklisted) return;
  const author = await getMember(guild, d.author_id);

  const ctx = {
    guild,
    author,
    channelId: String(d.channel_id),
    messageId: String(d.id),
    content: d.content ?? "",
    reply: (text) => send(d.channel_id, text, d.id),
    del: () => deleteMessage(d.channel_id, d.id),
  };

  if (!(await automod(ctx))) return;
  await runCommand(ctx);
}

function dispatch(ev) {
  if (ev.type !== "message") return;
  handleMessage(ev).catch((e) => logErr("Unhandled error in message handler:", e));
}

async function main() {
  if (!TOKEN) {
    console.error("Set TOKEN in your environment or in a .env file next to modbot.mjs.");
    process.exit(1);
  }

  startWeb({
    data, guildCfg, save, send, stats, builtins: () => [...commands.keys()],
    ownerPassword: process.env.OWNER_PASSWORD,
    secret: process.env.SESSION_SECRET,
    log, port: Number(process.env.PORT) || 3000,
  });

  try {
    me = await api("GET", "/me");
  } catch (e) {
    if (e.status === 401) console.error("Yapper rejected the token. Check that TOKEN is correct.");
    else console.error("Couldn't reach Yapper:", e.message);
    process.exit(1);
  }
  log(`Logged in as ${me.username} (id ${me.id})`);

  try {
    await api("PUT", "/commands", {
      commands: [...commands.values()].map((c) => ({ name: c.name, description: c.description })),
    });
    log(`Registered ${commands.size} command(s)`);
  } catch (e) {
    logErr("Couldn't register commands (the bot will still work):", e.message);
  }

  const init = await api("GET", "/events?after=0&wait=0");
  let last = init.last;
  log("ModBot ready. Press Ctrl+C to stop.");

  let fails = 0;
  while (true) {
    let out;
    try {
      out = await api("GET", `/events?after=${last}&wait=25`);
      if (fails) log("Connection to Yapper restored");
      fails = 0;
    } catch (e) {
      if (e.status === 401) {
        console.error("Yapper rejected the token. Check that TOKEN is correct.");
        process.exit(1);
      }
      fails++;
      const wait = Math.min(30, 2 ** fails);
      log(`Problem reaching Yapper: ${e.message}. Retrying in ${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    for (const ev of out.events ?? []) {
      if (ev.id <= last) continue;
      last = ev.id;
      dispatch(ev); // each event runs on its own, so a slow one never blocks polling
    }
  }
}

// Exported for tests only.
export { findBannedWord, findBadLink, parseId, takeToken };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.on("unhandledRejection", (e) => logErr("Unhandled rejection:", e));
  process.on("SIGINT", () => { log("Shutting down"); process.exit(0); });
  main();
}
