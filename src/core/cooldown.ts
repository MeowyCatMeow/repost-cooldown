/**
 * Repost Cooldown's decision logic. It has no Devvit imports: storage and the
 * Reddit API are passed in, so the rules can be tested without Reddit.
 *
 * Storage layout (Devvit Redis is already separate per subreddit):
 *   fp:link:<hash>   -> {"id","at"}    the post that currently owns this link
 *   fp:title-only:<hash> -> {"id","at"} the textless post that currently owns this title
 *   fp:title-text:<hash> -> {"id","at"} the post that currently owns this title and text
 *   fp:text:<hash>   -> {"id","at"}    the post that currently owns this body text
 *   post:<id>        -> {"at","keys"}  a known post and every fingerprint it may own
 *   seen:<id>        -> a token        the post's submit event is being, or was, handled
 *   gone:<id>        -> "1"            the post was deleted or removed; nothing about it may be recorded
 *   comment:<id>     -> a comment id   the removal comment the app left on a post it removed
 *   recorded         -> a sorted set   the ids of the posts that have a record, by the time they were made
 *
 * Nothing here names a person, and no title, text or link is kept: a
 * fingerprint is a one-way hash. Reddit's rules for apps (Devvit Rules,
 * "Enable and respect user deletions"; Developer Terms 3.3) say that what an
 * app keeps about a post must go once the post is deleted, removed or edited,
 * and that includes anything made from it. So the fingerprints of a post are
 * erased when it is deleted or removed, by anyone (forgetPost), and replaced
 * when it is edited.
 *
 * Not every such event arrives. Reddit sends none, for one, when a post that
 * was once removed is later deleted by its author, even if a moderator
 * approved it in between. So nothing relies on the events alone:
 *   - A daily pass reads Reddit's list of the subreddit's newest posts, erases
 *     the ones it shows as removed (forgetPosts), erases every recorded post
 *     that should be in the list and is not (forgetUnlisted), and reads the
 *     others again (indexExistingPosts).
 *   - Every key expires on its own, once its post is older than the cooldown
 *     and never more than 30 days after the app last read the post from Reddit
 *     and found it up, which is the limit Reddit recommends.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  isHomepage,
  isRedditLink,
  linksInText,
  normalizeTitle,
  normalizeUrl,
  redditPostIdFromUrl,
  titleWeight,
  toPostId,
} from './normalize.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** The longest cooldown a subreddit can set. */
const MAX_COOLDOWN_DAYS = 365;
/**
 * The longest anything is kept about a post without reading the post from
 * Reddit again. If a delete event never arrives, this is when the post is
 * forgotten anyway.
 */
const RETENTION_MS = 30 * DAY_MS;
/** How long after the fact Reddit may still send an event about a post, repeated or out of order. */
const LATE_EVENT_MS = 2 * DAY_MS;
/** How many posts are handled at once when many are handled together. */
const BATCH = 25;
/** The sorted set that lists the posts with a record: the only way to find them without knowing their ids. */
const RECORDED = 'recorded';

export type Settings = {
  cooldownDays: number;
  checkCrossposts: boolean;
  checkLinks: boolean;
  /** Links inside a post's text are compared when it has at most this many; 0 turns that off. */
  maxTextLinks: number;
  checkTitles: boolean;
  minTitleLength: number;
  checkText: boolean;
  minTextLength: number;
  exemptModerators: boolean;
  leaveComment: boolean;
  removalMessage: string;
};

export const DEFAULT_REMOVAL_MESSAGE =
  'Hi u/{author}, your post was removed because {reason}: [the earlier post]({original}), made {age}.\n\n' +
  'In r/{subreddit} the same post can be shared again once {cooldown} days have passed since the original.\n\n' +
  '*I am a bot. If you think this was a mistake, please ' +
  '[message the moderators](https://www.reddit.com/message/compose?to=r/{subreddit}).*';

export const DEFAULT_SETTINGS: Settings = {
  cooldownDays: 30,
  checkCrossposts: true,
  checkLinks: true,
  maxTextLinks: 5,
  checkTitles: true,
  minTitleLength: 12,
  checkText: true,
  minTextLength: 40,
  exemptModerators: true,
  leaveComment: true,
  removalMessage: DEFAULT_REMOVAL_MESSAGE,
};

/** Turns the raw values of the app's settings form into `Settings`. */
export function parseSettings(raw: Record<string, unknown> | undefined): Settings {
  const bool = (name: keyof Settings): boolean => {
    const value = raw?.[name];
    return typeof value === 'boolean' ? value : (DEFAULT_SETTINGS[name] as boolean);
  };
  const num = (name: keyof Settings, min: number, max: number): number => {
    const value = Number(raw?.[name]);
    if (raw?.[name] == null || raw[name] === '' || !Number.isFinite(value)) return DEFAULT_SETTINGS[name] as number;
    return Math.min(max, Math.max(min, value));
  };
  const message = raw?.removalMessage;
  return {
    cooldownDays: num('cooldownDays', 1, MAX_COOLDOWN_DAYS),
    checkCrossposts: bool('checkCrossposts'),
    checkLinks: bool('checkLinks'),
    maxTextLinks: num('maxTextLinks', 0, 100),
    checkTitles: bool('checkTitles'),
    minTitleLength: num('minTitleLength', 0, 300),
    checkText: bool('checkText'),
    minTextLength: num('minTextLength', 0, 40000),
    exemptModerators: bool('exemptModerators'),
    leaveComment: bool('leaveComment'),
    removalMessage: typeof message === 'string' && message.trim() ? message : DEFAULT_REMOVAL_MESSAGE,
  };
}

/** The subset of Devvit's Redis client this app uses. */
export interface Store {
  get(key: string): Promise<string | undefined | null>;
  set(key: string, value: string, options?: { nx?: boolean; expiration?: Date }): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  zAdd(key: string, ...members: Array<{ member: string; score: number }>): Promise<unknown>;
  /** The members whose score is from `min` to `max`. */
  zRange(key: string, min: number, max: number, options: { by: 'score' }): Promise<Array<{ member: string; score: number }>>;
  zRem(key: string, members: string[]): Promise<unknown>;
  zRemRangeByScore(key: string, min: number, max: number): Promise<unknown>;
}

/** What the app needs to know about an existing post. */
export type PostInfo = {
  id: string;
  subredditId: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
  /** Removed, marked as spam, filtered, or deleted by its author. */
  removed: boolean;
  permalink?: string;
};

/** The Reddit calls the app makes. */
export interface RedditGateway {
  /** Throws when the post cannot be read. */
  getPostInfo(id: string): Promise<PostInfo>;
  /** The post as it is on Reddit now, or `undefined` when it is deleted or removed. Throws when it cannot be read. */
  getPost(id: string): Promise<IncomingPost | undefined>;
  isModerator(username: string): Promise<boolean>;
  remove(id: string): Promise<void>;
  /** Posts a comment on the post, as a stickied moderator comment, and returns the comment's id. */
  comment(id: string, text: string): Promise<string | undefined>;
  /** Deletes a comment the app made. */
  deleteComment(commentId: string): Promise<void>;
  addRemovalNote(id: string, note: string): Promise<void>;
}

export type Deps = {
  store: Store;
  reddit: RedditGateway;
  now: () => number;
  /** Usernames that are never removed, such as the app's own account. */
  exemptAuthors?: string[];
  log?: (message: string) => void;
};

export type IncomingPost = {
  id: string;
  title: string;
  url: string;
  /** The body of a text post; empty or missing for other kinds of post. */
  body?: string;
  /** True for a text post, whose `url` is only its own address. */
  isSelf?: boolean;
  authorName: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
  crosspostParentId?: string;
  subredditId: string;
  subredditName: string;
};

export type Reason = 'crosspost' | 'link' | 'text' | 'title';

export type Fingerprint = { kind: 'link' | 'text' | 'title'; key: string };

/** `gone` means the post repeats nothing, and was deleted or removed before the app got to it, so it is not recorded. */
export type Outcome =
  | { action: 'duplicate-event' }
  | { action: 'gone' }
  | { action: 'indexed'; compared: Array<Fingerprint['kind']> }
  | { action: 'exempt'; reason: Reason; originalId: string }
  | { action: 'removed'; reason: Reason; originalId: string };

type Entry = { id: string; at: number };
type PostRecord = { at: number; keys: string[] };

const REASON_TEXT: Record<Reason, string> = {
  crosspost: "it is a crosspost of a recent post from this subreddit",
  link: 'it shares a link with a recent post',
  text: 'it has the same text as a recent post',
  title: 'it repeats the title of a recent post',
};

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

function parseJson(text: string | undefined | null): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** A stored fingerprint owner, or `undefined` when the value is missing or not in that shape. */
function readEntry(text: string | undefined | null): Entry | undefined {
  const value = parseJson(text);
  if (typeof value?.id !== 'string' || typeof value.at !== 'number' || !Number.isFinite(value.at)) return undefined;
  return { id: value.id, at: value.at };
}

/** A stored post record, or `undefined` when the value is missing or not in that shape. */
function readRecord(text: string | undefined | null): PostRecord | undefined {
  const value = parseJson(text);
  if (typeof value?.at !== 'number' || !Number.isFinite(value.at)) return undefined;
  const keys = Array.isArray(value.keys) ? value.keys.filter((key): key is string => typeof key === 'string') : [];
  return { at: value.at, keys };
}

/** Reddit reports times in seconds in some places and milliseconds in others. */
export function toMillis(time: number | undefined, fallback: number): number {
  if (!time || !Number.isFinite(time)) return fallback;
  return time < 1e11 ? time * 1000 : time;
}

/** The link, text and title keys a post is compared by, honouring the settings. */
export function fingerprintsOf(
  post: Pick<IncomingPost, 'id' | 'title' | 'url' | 'body' | 'isSelf'>,
  settings: Settings
): Fingerprint[] {
  const prints: Fingerprint[] = [];
  if (settings.checkLinks) {
    const links = new Set<string>();
    if (!post.isSelf) {
      const link = normalizeUrl(post.url);
      // A text post's "link" is its own permalink, which says nothing.
      if (link && !isHomepage(link) && redditPostIdFromUrl(post.url) !== post.id) links.add(link);
    }
    if (settings.maxTextLinks > 0 && post.body) {
      // Links to Reddit inside a post's text are conversation ("as discussed
      // in this thread"), not shared content, so they are not compared.
      const inText = new Set<string>();
      for (const raw of linksInText(post.body)) {
        const link = normalizeUrl(raw);
        if (link && !isHomepage(link) && !isRedditLink(link)) inText.add(link);
      }
      // A post with many links is a roundup, not a repost of any one of them.
      if (inText.size <= settings.maxTextLinks) for (const link of inText) links.add(link);
    }
    for (const link of links) prints.push({ kind: 'link', key: `fp:link:${hash(link)}` });
  }
  if (settings.checkText) {
    // Compared the same way as titles: capitals, punctuation and spacing are ignored.
    const text = normalizeTitle(post.body ?? '');
    if (text && titleWeight(text) >= settings.minTextLength) {
      prints.push({ kind: 'text', key: `fp:text:${hash(text)}` });
    }
  }
  if (settings.checkTitles) {
    const title = normalizeTitle(post.title);
    if (title && titleWeight(title) >= settings.minTitleLength) {
      // A title alone only identifies a post that has no text (an image, a
      // video, a bare link). For a post with text, the text must match too,
      // so two different posts that happen to share a title are both kept.
      const text = normalizeTitle(post.body ?? '');
      const key = text ? `fp:title-text:${hash(`${title}\n${text}`)}` : `fp:title-only:${hash(title)}`;
      prints.push({ kind: 'title', key });
    }
  }
  return prints;
}

export function formatAge(ms: number): string {
  if (ms < HOUR_MS) return 'less than an hour ago';
  if (ms < DAY_MS) {
    const hours = Math.floor(ms / HOUR_MS);
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  const days = Math.floor(ms / DAY_MS);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

export function renderRemovalMessage(
  template: string,
  values: { author: string; reason: Reason; original: string; ageMs: number; cooldownDays: number; subreddit: string }
): string {
  const fill: Record<string, string> = {
    author: values.author,
    reason: REASON_TEXT[values.reason],
    original: values.original,
    age: formatAge(values.ageMs),
    cooldown: String(values.cooldownDays),
    subreddit: values.subreddit,
  };
  // Anything in braces that is not one of the names above is left as written.
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(fill, name) ? fill[name]! : whole));
}

function permalinkOf(info: PostInfo | undefined, id: string): string {
  const path = info?.permalink;
  if (path) return path.startsWith('http') ? path : `https://www.reddit.com${path}`;
  return `https://www.reddit.com/comments/${id.replace(/^t3_/, '')}`;
}

/** True when the post must stay up: its author is exempt, or cannot be checked. */
async function isExempt(post: IncomingPost, settings: Settings, deps: Deps): Promise<boolean> {
  const author = post.authorName.toLowerCase();
  // Without a name there is no telling who posted it, so it is left alone.
  if (!author) return true;
  if (author === 'automoderator') return true;
  if (deps.exemptAuthors?.some((name) => name.toLowerCase() === author)) return true;
  if (!settings.exemptModerators) return false;
  try {
    return await deps.reddit.isModerator(post.authorName);
  } catch (error) {
    // A moderator's post must not be removed because Reddit failed to answer.
    // The log names posts only, never the people who made them.
    deps.log?.(`could not check whether the author of ${post.id} is a moderator, so it stays up: ${String(error)}`);
    return true;
  }
}

/** Erases the fingerprints in `keys` that belong to the post, or to no post that can be read. */
async function release(id: string, keys: Iterable<string>, store: Store): Promise<void> {
  for (const key of keys) {
    const value = await store.get(key);
    if (!value) continue;
    // Another post may have taken the fingerprint over; that one keeps it.
    const owner = readEntry(value);
    if (!owner || owner.id === id) await store.del(key);
  }
}

/**
 * Records `post` as the owner of each fingerprint that is free, and gives up
 * the ones it was recorded with before and no longer has. A fingerprint in
 * `replaceable` is taken over even though it has an owner, because that owner
 * is past the cooldown or no longer exists. One in `taken` is left to an older
 * post that is being recorded in the same pass.
 *
 * Returns false when the post turned out to be deleted or removed, in which
 * case nothing of it is kept.
 */
async function indexPost(
  post: IncomingPost,
  prints: Fingerprint[],
  cooldownMs: number,
  deps: Pick<Deps, 'store' | 'now'>,
  keys: { replaceable?: ReadonlySet<string>; taken?: ReadonlySet<string> } = {}
): Promise<boolean> {
  const { store } = deps;
  const now = deps.now();
  // An hour of slack so a key never disappears just before its cooldown ends.
  const cooldownEnds = post.createdAt + cooldownMs + HOUR_MS;
  if (cooldownEnds <= now) return true;
  // The post is known to be up now, so it may be kept from now, for no longer than Reddit recommends.
  const expiration = new Date(Math.min(cooldownEnds, now + RETENTION_MS));
  const value = JSON.stringify({ id: post.id, at: post.createdAt } satisfies Entry);
  const recordKey = `post:${post.id}`;
  const current = new Set(prints.map((print) => print.key));

  // The order matters, because erasing a post later relies on its record
  // naming every fingerprint it owns: old fingerprints go first, then the
  // record is written, then the fingerprints. Cut short at any point, this
  // leaves no fingerprint that the record does not name.
  const before = readRecord(await store.get(recordKey));
  if (before) await release(post.id, before.keys.filter((key) => !current.has(key)), store);
  const record: PostRecord = { at: post.createdAt, keys: [...current] };
  await store.set(recordKey, JSON.stringify(record), { expiration });
  await store.zAdd(RECORDED, { member: post.id, score: post.createdAt });
  const had = new Set(before?.keys);
  for (const key of current) {
    if (keys.taken?.has(key)) continue;
    // A fingerprint the post already owns is written again, so that it expires
    // when the record does and not when it was first due to.
    const own = keys.replaceable?.has(key) || (had.has(key) && readEntry(await store.get(key))?.id === post.id);
    // Otherwise "set if absent": of two posts recorded at the same moment, only one gets the fingerprint.
    await store.set(key, value, own ? { expiration } : { nx: true, expiration });
  }

  // Looked for last, so that a deletion at any moment before this is seen
  // here, and one at any moment after finds the finished record and erases it.
  if (await store.get(`gone:${post.id}`)) {
    // The deletion may have erased the record before the fingerprints were
    // written, so they are erased by name rather than through the record.
    await release(post.id, current, store);
    await store.del(recordKey);
    await store.zRem(RECORDED, [post.id]);
    return false;
  }
  return true;
}

/**
 * Handles a newly submitted post: removes it when it repeats a post that is
 * still inside the cooldown, otherwise remembers it as an original.
 */
export async function handleNewPost(post: IncomingPost, settings: Settings, deps: Deps): Promise<Outcome> {
  const { store, reddit } = deps;
  const cooldownMs = settings.cooldownDays * DAY_MS;

  // Reddit can deliver the same event more than once, even at the same moment.
  // "Set if absent", then read back: only the delivery whose token was stored
  // goes on, so a post is never removed and commented on twice.
  const seenKey = `seen:${post.id}`;
  const token = randomUUID();
  await store.set(seenKey, token, { nx: true, expiration: new Date(deps.now() + LATE_EVENT_MS) });
  if ((await store.get(seenKey)) !== token) return { action: 'duplicate-event' };

  try {
    // Events arrive late and out of order: the post may already be deleted or
    // removed, or held back by a filter. It is still checked, so that a repost
    // waiting for approval is taken out of the queue, but it is not recorded.
    const gone = Boolean(await store.get(`gone:${post.id}`));

    const prints = fingerprintsOf(post, settings);

    const infoCache = new Map<string, PostInfo | undefined>();
    const getInfo = async (id: string): Promise<PostInfo | undefined> => {
      if (!infoCache.has(id)) {
        let info: PostInfo | undefined;
        try {
          info = await reddit.getPostInfo(id);
        } catch (error) {
          deps.log?.(`could not read ${id}: ${String(error)}`);
        }
        infoCache.set(id, info);
      }
      return infoCache.get(id);
    };

    type Candidate = { reason: Reason; id: string; at: number; key?: string };
    const candidates: Candidate[] = [];

    // The post this one is a crosspost of. A plain link to a post is treated like a crosspost of it.
    const linkedId = toPostId(post.crosspostParentId) ?? (post.isSelf ? undefined : redditPostIdFromUrl(post.url));
    const parentId = linkedId !== post.id ? linkedId : undefined;

    if (settings.checkCrossposts && parentId) {
      const known = readRecord(await store.get(`post:${parentId}`));
      if (known) {
        candidates.push({ reason: 'crosspost', id: parentId, at: known.at });
      } else {
        const parent = await getInfo(parentId);
        if (parent && parent.subredditId === post.subredditId) {
          candidates.push({ reason: 'crosspost', id: parentId, at: parent.createdAt });
        }
      }
    }
    for (const print of prints) {
      const entry = readEntry(await store.get(print.key));
      if (entry) candidates.push({ reason: print.kind, id: entry.id, at: entry.at, key: print.key });
    }

    const replaceable = new Set<string>();
    let match: Candidate | undefined;
    for (const candidate of candidates) {
      if (candidate.id === post.id) continue;
      // With the crosspost check switched off, crossposts are allowed: one is
      // not a repost of the very post it shows, whose link and title it carries.
      if (!settings.checkCrossposts && candidate.id === parentId) continue;
      const age = post.createdAt - candidate.at;
      if (age >= cooldownMs) {
        if (candidate.key) replaceable.add(candidate.key);
        continue;
      }
      if (age < 0) continue;
      // Only a post that is still up counts as an original. When that cannot be
      // confirmed, leave the new post alone rather than remove it on a guess.
      const info = await getInfo(candidate.id);
      if (!info) continue;
      if (info.removed) {
        // Deleted or removed, and the event that said so never arrived: erase it now.
        await forgetPost(candidate.id, deps);
        if (candidate.key) replaceable.add(candidate.key);
        continue;
      }
      match = candidate;
      break;
    }

    if (!match) {
      const kept = !gone && (await indexPost(post, prints, cooldownMs, deps, { replaceable }));
      return kept ? { action: 'indexed', compared: [...new Set(prints.map((print) => print.kind))] } : { action: 'gone' };
    }
    const found = { reason: match.reason, originalId: match.id };

    if (await isExempt(post, settings, deps)) {
      if (!gone) await indexPost(post, prints, cooldownMs, deps, { replaceable });
      return { action: 'exempt', ...found };
    }

    await reddit.remove(post.id);

    const ageMs = post.createdAt - match.at;
    if (settings.leaveComment) {
      const text = renderRemovalMessage(settings.removalMessage, {
        author: post.authorName,
        reason: match.reason,
        original: permalinkOf(infoCache.get(match.id), match.id),
        ageMs,
        cooldownDays: settings.cooldownDays,
        subreddit: post.subredditName,
      });
      try {
        const commentId = await reddit.comment(post.id, text);
        // Remembered so that the comment can be taken off if a moderator approves the post after all.
        if (commentId) {
          const keptFor = Math.min(cooldownMs + HOUR_MS, RETENTION_MS);
          await store.set(`comment:${post.id}`, commentId, { expiration: new Date(deps.now() + keptFor) });
        }
      } catch (error) {
        deps.log?.(`removed ${post.id} but could not comment: ${String(error)}`);
      }
    }
    try {
      // Mod notes are limited to 100 characters.
      const what = match.reason === 'crosspost' ? 'crosspost of' : `same ${match.reason} as`;
      await reddit.addRemovalNote(post.id, `Repost Cooldown: ${what} ${match.id}, made ${formatAge(ageMs)}`);
    } catch (error) {
      deps.log?.(`removed ${post.id} but could not add a removal note: ${String(error)}`);
    }
    return { action: 'removed', ...found };
  } catch (error) {
    // Let a redelivered event try again.
    await store.del(seenKey);
    throw error;
  }
}

/**
 * Erases everything the app keeps about a post that was deleted or removed,
 * whoever did it: its author, a moderator, AutoModerator, another app or
 * Reddit. The post no longer counts as an original, so what it contained can
 * be posted again. Returns whether the post was recorded.
 */
export async function forgetPost(rawId: string, deps: Pick<Deps, 'store' | 'now'>): Promise<boolean> {
  const id = toPostId(rawId);
  if (!id) return false;
  const { store } = deps;
  // Written before anything is erased: whatever is recording this post at the
  // same moment looks for this after its last write, and erases what it wrote.
  await store.set(`gone:${id}`, '1', { expiration: new Date(deps.now() + LATE_EVENT_MS) });
  const recordKey = `post:${id}`;
  const record = readRecord(await store.get(recordKey));
  if (record) await release(id, record.keys, store);
  // A "removed:" mark is something earlier versions of the app kept.
  await store.del(recordKey, `removed:${id}`);
  await store.zRem(RECORDED, [id]);
  return record !== undefined;
}

/** Erases many deleted or removed posts. Returns how many of them were recorded. */
export async function forgetPosts(ids: string[], deps: Pick<Deps, 'store' | 'now'>): Promise<number> {
  let recorded = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const results = await Promise.all(ids.slice(i, i + BATCH).map((id) => forgetPost(id, deps)));
    recorded += results.filter(Boolean).length;
  }
  return recorded;
}

/**
 * Erases the recorded posts that Reddit no longer lists. `listed` holds the
 * posts that Reddit's list of the subreddit's newest posts shows as up, and
 * the list was read back to the time `from`. A recorded post made since then
 * that is not among them was deleted, or removed, and no event said so.
 *
 * Posts made after `until` are left alone, because the list may not show a
 * post in its first minutes. So are posts made before `from`: the list did
 * not reach them, which says nothing about them. Returns how many recorded
 * posts were erased.
 */
export async function forgetUnlisted(
  listed: ReadonlySet<string>,
  from: number,
  until: number,
  deps: Pick<Deps, 'store' | 'now'>
): Promise<number> {
  if (!(from <= until)) return 0;
  const recorded = await deps.store.zRange(RECORDED, from, until, { by: 'score' });
  return forgetPosts(
    recorded.map((entry) => entry.member).filter((id) => !listed.has(id)),
    deps
  );
}

/**
 * Re-reads a post that was edited: gives up what it no longer contains and
 * records what it contains now, so that nothing is kept of a link or text
 * that is no longer there. An edit never gets a post removed. Returns whether
 * the post is one the app keeps track of.
 */
export async function handlePostEdited(post: IncomingPost, settings: Settings, deps: Deps): Promise<boolean> {
  // A post the app removed, one that was deleted or removed, one past the
  // cooldown, or one it never saw has no record.
  const record = readRecord(await deps.store.get(`post:${post.id}`));
  if (!record) return false;
  // The post keeps the age it was recorded with; an edit does not restart its cooldown.
  return indexPost({ ...post, createdAt: record.at }, fingerprintsOf(post, settings), settings.cooldownDays * DAY_MS, deps);
}

/**
 * A moderator approved a post, so it is up again. If the app had removed it as
 * a repost, the app's comment saying so is no longer true and is deleted. If
 * the post is not recorded, because it was erased when it was removed or was
 * never seen, it is read from Reddit and recorded: it counts as an original
 * from now on. An approved post is never removed.
 *
 * The settings are only asked for when the post has to be recorded.
 */
export async function handlePostApproved(
  rawId: string,
  loadSettings: () => Promise<Settings>,
  deps: Deps
): Promise<{ recorded: boolean; commentDeleted: boolean }> {
  const result = { recorded: false, commentDeleted: false };
  const id = toPostId(rawId);
  if (!id) return result;
  const { store, reddit } = deps;

  const commentKey = `comment:${id}`;
  const commentId = await store.get(commentKey);
  if (commentId) {
    try {
      await reddit.deleteComment(commentId);
      result.commentDeleted = true;
    } catch (error) {
      deps.log?.(`${id} was approved but the removal comment could not be deleted: ${String(error)}`);
    }
    await store.del(commentKey);
  }

  // A moderator has decided the post stays, so a submit event for it that
  // arrives only now must not get it checked and removed.
  await store.set(`seen:${id}`, 'approved', { expiration: new Date(deps.now() + LATE_EVENT_MS) });

  if (readRecord(await store.get(`post:${id}`))) return result;
  // Asked of Reddit rather than taken from the event: the post may have been
  // removed again, or deleted, since it was approved.
  const post = await reddit.getPost(id);
  if (!post) return result;
  const settings = await loadSettings();
  const cooldownMs = settings.cooldownDays * DAY_MS;
  if (post.createdAt + cooldownMs <= deps.now()) return result;
  await store.del(`gone:${id}`);
  result.recorded = await indexPost(post, fingerprintsOf(post, settings), cooldownMs, deps);
  return result;
}

/**
 * Records posts that Reddit lists as up: on install, on update, on a manual
 * rescan and once a day. Nothing is removed. When several of them share a link
 * or title, the oldest one becomes the original. A post that is already
 * recorded is read again, which is also what lets it be kept past 30 days
 * under a longer cooldown. Returns how many posts were recorded.
 */
export async function indexExistingPosts(posts: IncomingPost[], settings: Settings, deps: Deps): Promise<number> {
  const cooldownMs = settings.cooldownDays * DAY_MS;
  const now = deps.now();
  const recent = posts
    .filter((post) => post.createdAt + cooldownMs > now)
    .sort((a, b) => a.createdAt - b.createdAt);

  // Ownership is decided oldest first: the oldest post with a link or title is
  // the original. A fingerprint that an older post in this pass has is left to
  // it; "set if absent" keeps whatever the live trigger has already recorded.
  const seen = new Set<string>();
  const jobs: Array<() => Promise<boolean>> = [];
  for (const post of recent) {
    const prints = fingerprintsOf(post, settings);
    const taken = new Set(prints.map((print) => print.key).filter((key) => seen.has(key)));
    for (const print of prints) seen.add(print.key);
    // Each post is read again like an edited one, so a rescan also drops what
    // a post no longer has, or what the settings no longer compare.
    jobs.push(() => indexPost(post, prints, cooldownMs, deps, { taken }));
  }
  // Recorded newest first: if Reddit cuts a long pass short, what is missing
  // is the oldest posts, which have the least of their cooldown left.
  jobs.reverse();

  let recorded = 0;
  for (let i = 0; i < jobs.length; i += BATCH) {
    const results = await Promise.all(jobs.slice(i, i + BATCH).map((job) => job()));
    recorded += results.filter(Boolean).length;
  }
  // The list of recorded posts does not expire by itself the way records do.
  await deps.store.zRemRangeByScore(RECORDED, 0, now - cooldownMs - DAY_MS);
  return recorded;
}
