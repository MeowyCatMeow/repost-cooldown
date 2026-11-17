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
 *   gone:<id>        -> "1"            the post was deleted, or removed in a way that does not count; nothing about it may be recorded
 *   removed:<id>     -> "1"            a moderator removed the post; it is still on Reddit and still counts as an original
 *   comment:<id>     -> a comment id   the removal comment the app left on a post it removed
 *   editing:<id>     -> a token        the post was edited into a repost and is being removed; gone when that is done
 *   recorded        -> a sorted set   the ids of the posts that have a record, by the time they were made
 *   keys             -> a sorted set   the name of every key above that the app has written
 *
 * Nothing here names a person, and no title, text or link is kept: a
 * fingerprint is a one-way hash.
 *
 * What is kept, and until when:
 *   - A post that is up is recorded until its cooldown ends.
 *   - A post that a moderator, a person, removed stays recorded, so that
 *     posting it again is removed too, but only in a subreddit whose
 *     moderators have switched that option on. With the option off, which is
 *     how it comes, such a post is erased like any other removed post.
 *     For a post kept this way the app goes by what Reddit tells it: an
 *     approval makes it an ordinary post again, a delete event erases it.
 *     Reddit sends no event when the author of a removed post deletes it, and
 *     the app does not go looking, so that post counts until its time is up.
 *   - A post that its author deleted, or that Reddit took down, is erased as
 *     soon as the app learns of it (forgetPost). So is one removed by
 *     AutoModerator, a filter or another app.
 *   - An edited post is read again, and what it no longer has is erased. If
 *     the edit put into it what another post already has, it is removed like
 *     a new post that repeats one, and erased.
 *   - Nothing outlives 30 days from the last time the app read the post from
 *     Reddit and found it up, the longest Reddit recommends. So a post that a
 *     moderator removed is forgotten 30 days after that at the latest.
 *
 * The erasing is what Reddit's rules for apps require (Devvit Rules, "Enable
 * and respect user deletions"; Developer Terms 3.3). Not every event arrives,
 * though. Reddit sends none when a post that was once removed is later deleted
 * by its author, even if a moderator approved it in between. So nothing relies
 * on events alone, with the one exception above: a daily pass reads Reddit's
 * list of the subreddit's newest posts, erases the removed ones that no
 * moderator removed (forgetRemoved), erases every other recorded post that
 * should be in the list and is not (forgetUnlisted), and reads the rest again
 * (indexExistingPosts).
 *
 * Every key is put on the `keys` list before it is written, because Reddit
 * gives an app no way to list its own keys. That is what lets a moderator
 * erase everything the app has stored (eraseEverything).
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
/** The longest one delivery of an event may keep a post to itself while it removes it. */
const CLAIM_MS = 10 * 60 * 1000;
/** How many posts are handled at once when many are handled together. */
const BATCH = 25;
/** The sorted set that lists the posts with a record: the only way to find them without knowing their ids. */
const RECORDED = 'recorded';
/** The sorted set that lists every key the app has written, by the time the key is certain to be gone. */
const KEYS = 'keys';

export type Settings = {
  cooldownDays: number;
  /** A post that a moderator removed still counts as an original. */
  checkRemovedPosts: boolean;
  /** Lowercase names of moderator accounts whose removals do not count: bots that run as ordinary accounts. */
  ignoredRemovers: string[];
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
  /** The comment left when the original is a post that a moderator removed. */
  removedOriginalMessage: string;
};

export const DEFAULT_REMOVAL_MESSAGE =
  'Hi u/{author}, your post was removed because {reason}: [the earlier post]({original}), made {age}.\n\n' +
  'In r/{subreddit} the same post can be shared again once {cooldown} days have passed since the original.\n\n' +
  '*I am a bot. If you think this was a mistake, please ' +
  '[message the moderators](https://www.reddit.com/message/compose?to=r/{subreddit}).*';

export const DEFAULT_REMOVED_ORIGINAL_MESSAGE =
  'Hi u/{author}, your post was removed because it repeats [an earlier post]({original}) ' +
  'that the moderators of r/{subreddit} removed.\n\n' +
  'Please do not post it again.\n\n' +
  '*I am a bot. If you think this was a mistake, please ' +
  '[message the moderators](https://www.reddit.com/message/compose?to=r/{subreddit}).*';

export const DEFAULT_SETTINGS: Settings = {
  cooldownDays: 30,
  // An option the moderators switch on themselves.
  checkRemovedPosts: false,
  ignoredRemovers: [],
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
  removedOriginalMessage: DEFAULT_REMOVED_ORIGINAL_MESSAGE,
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
  const text = (name: 'removalMessage' | 'removedOriginalMessage'): string => {
    const value = raw?.[name];
    return typeof value === 'string' && value.trim() ? value : DEFAULT_SETTINGS[name];
  };
  // "u/Name, other-name" to ["name", "other-name"].
  const names = (value: unknown): string[] =>
    typeof value === 'string'
      ? value
          .split(/[\s,]+/)
          .map((name) => name.replace(/^\/?u\//i, '').toLowerCase())
          .filter(Boolean)
      : [];
  return {
    cooldownDays: num('cooldownDays', 1, MAX_COOLDOWN_DAYS),
    checkRemovedPosts: bool('checkRemovedPosts'),
    ignoredRemovers: names(raw?.ignoredRemovers),
    checkCrossposts: bool('checkCrossposts'),
    checkLinks: bool('checkLinks'),
    maxTextLinks: num('maxTextLinks', 0, 100),
    checkTitles: bool('checkTitles'),
    minTitleLength: num('minTitleLength', 0, 300),
    checkText: bool('checkText'),
    minTextLength: num('minTextLength', 0, 40000),
    exemptModerators: bool('exemptModerators'),
    leaveComment: bool('leaveComment'),
    removalMessage: text('removalMessage'),
    removedOriginalMessage: text('removedOriginalMessage'),
  };
}

/** The subset of Devvit's Redis client this app uses. */
export interface Store {
  get(key: string): Promise<string | undefined | null>;
  set(key: string, value: string, options?: { nx?: boolean; expiration?: Date }): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  /** How many of the keys exist. */
  exists(...keys: string[]): Promise<number>;
  zAdd(key: string, ...members: Array<{ member: string; score: number }>): Promise<unknown>;
  /** By score: the members whose score is from `start` to `stop`. By rank: the members at those positions, lowest score first. */
  zRange(
    key: string,
    start: number,
    stop: number,
    options: { by: 'score' | 'rank' }
  ): Promise<Array<{ member: string; score: number }>>;
  zRem(key: string, members: string[]): Promise<unknown>;
  zRemRangeByScore(key: string, min: number, max: number): Promise<unknown>;
}

/** Up, removed (also: marked as spam, or held back by a filter), or deleted by its author. */
export type PostState = 'up' | 'removed' | 'deleted';

/** What the app needs to know about an existing post. */
export type PostInfo = {
  id: string;
  subredditId: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
  state: PostState;
  permalink?: string;
};

/** The Reddit calls the app makes. */
export interface RedditGateway {
  /** Throws when the post cannot be read. */
  getPostInfo(id: string): Promise<PostInfo>;
  /**
   * The post as it is on Reddit now. A moderator can still read a removed
   * post; a deleted one has nothing left to read. Throws when it cannot be read.
   */
  getPost(id: string): Promise<{ state: PostState; post: IncomingPost }>;
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

/**
 * `gone` means the post repeats nothing, and was deleted or removed before the
 * app got to it, so it is not recorded. `originalRemoved` is set when the
 * original is a post that a moderator removed.
 */
export type Outcome =
  | { action: 'duplicate-event' }
  | { action: 'gone' }
  | { action: 'indexed'; compared: Array<Fingerprint['kind']> }
  | { action: 'exempt'; reason: Reason; originalId: string; originalRemoved?: true }
  | { action: 'removed'; reason: Reason; originalId: string; originalRemoved?: true };

/**
 * What became of an edit. `ignored`: the post is not one the app keeps track
 * of, or the edit changed nothing it is compared by. `recorded`: the post was
 * recorded as it is now. `gone`: it turned out to be deleted, and was erased.
 * `removed`: the edit made it a repost, and it was removed.
 */
export type EditOutcome =
  | { action: 'ignored' }
  | { action: 'duplicate-event' }
  | { action: 'recorded' }
  | { action: 'gone' }
  | { action: 'exempt'; reason: Reason; originalId: string; originalRemoved?: true }
  | { action: 'removed'; reason: Reason; originalId: string; originalRemoved?: true };

type Entry = { id: string; at: number };
type PostRecord = { at: number; keys: string[] };
/** A post that another post may be a repost of, and what the two share. */
type Candidate = { reason: Reason; id: string; at: number; key?: string };
/** What a search for a post's original found. */
type Search = {
  match?: Candidate;
  /** The original is a post that a moderator removed. */
  originalRemoved: boolean;
  /** What Reddit said about the original, when it was asked. */
  info?: PostInfo;
  /** Fingerprints whose owner no longer counts, which the post may take over. */
  replaceable: Set<string>;
};
type InfoReader = (id: string) => Promise<PostInfo | undefined>;

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

/**
 * Puts keys on the list of everything the app has written. This is done before
 * a key is written, so that no key can exist without being on the list.
 */
async function listKeys(names: string[], deps: Pick<Deps, 'store' | 'now'>): Promise<void> {
  if (names.length === 0) return;
  // No key is kept for longer than RETENTION_MS after it is written, so by
  // this time it is gone, unless it is written again and listed again.
  const gone = deps.now() + RETENTION_MS + DAY_MS;
  await deps.store.zAdd(KEYS, ...names.map((member) => ({ member, score: gone })));
}

/** Takes keys that were erased off that list. */
async function unlistKeys(names: string[], store: Store): Promise<void> {
  if (names.length > 0) await store.zRem(KEYS, names);
}

/** Erases keys and takes them off the list, so that the two never drift apart. */
async function drop(store: Store, ...names: string[]): Promise<void> {
  await store.del(...names);
  await unlistKeys(names, store);
}

/** Erases the fingerprints in `keys` that belong to the post, or to no post that can be read. */
async function release(id: string, keys: Iterable<string>, store: Store): Promise<void> {
  const erased: string[] = [];
  for (const key of keys) {
    const value = await store.get(key);
    if (!value) continue;
    // Another post may have taken the fingerprint over; that one keeps it.
    const owner = readEntry(value);
    if (!owner || owner.id === id) {
      await store.del(key);
      erased.push(key);
    }
  }
  await unlistKeys(erased, store);
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
  await listKeys([recordKey, ...current], deps);
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
    await drop(store, recordKey);
    await store.zRem(RECORDED, [post.id]);
    return false;
  }
  return true;
}

/** Reads what Reddit says about a post, once for each post. A post that cannot be read gives `undefined`. */
function infoReader(deps: Deps): InfoReader {
  const cache = new Map<string, PostInfo | undefined>();
  return async (id) => {
    if (!cache.has(id)) {
      let info: PostInfo | undefined;
      try {
        info = await deps.reddit.getPostInfo(id);
      } catch (error) {
        deps.log?.(`could not read ${id}: ${String(error)}`);
      }
      cache.set(id, info);
    }
    return cache.get(id);
  };
}

/**
 * Looks among the candidates for a post that still counts as an original of
 * `post`. `since` is when the post came to say what it says: when it was made
 * or, for an edit, now. `allowedId` is a post it is allowed to repeat.
 */
async function findOriginal(
  post: IncomingPost,
  candidates: Candidate[],
  since: number,
  settings: Settings,
  deps: Deps,
  getInfo: InfoReader,
  allowedId?: string
): Promise<Search> {
  const { store } = deps;
  const cooldownMs = settings.cooldownDays * DAY_MS;
  const replaceable = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.id === post.id || candidate.id === allowedId) continue;
    const age = since - candidate.at;
    if (age >= cooldownMs) {
      if (candidate.key) replaceable.add(candidate.key);
      continue;
    }
    if (age < 0) continue;
    const removedKey = `removed:${candidate.id}`;
    const marked = Boolean(await store.get(removedKey));
    if (marked && settings.checkRemovedPosts) {
      // A moderator removed it, and the subreddit wants that to count. For
      // such a post the app goes by what Reddit has told it, and does not
      // ask what became of the post since. Reddit reports an approval. It
      // reports nothing when the author of a removed post deletes it, so
      // that post keeps counting until its time is up.
      return { match: candidate, originalRemoved: true, replaceable };
    }
    // Any other post counts as an original only while it is up. When that
    // cannot be confirmed, leave the post alone rather than remove it on a
    // guess.
    const info = await getInfo(candidate.id);
    if (!info) continue;
    if (info.state === 'up') {
      // A mark that a moderator once removed it is out of date here.
      if (marked) await drop(store, removedKey);
      return { match: candidate, originalRemoved: false, info, replaceable };
    }
    // Deleted by its author, or removed in a way that does not count: it is
    // erased, here and now if the event that said so never arrived.
    await forgetPost(candidate.id, deps);
    if (candidate.key) replaceable.add(candidate.key);
  }
  return { originalRemoved: false, replaceable };
}

/** The part of an outcome that says which post was repeated, and how. */
function describe(match: Candidate, search: Search): { reason: Reason; originalId: string; originalRemoved?: true } {
  return { reason: match.reason, originalId: match.id, ...(search.originalRemoved ? { originalRemoved: true as const } : {}) };
}

/**
 * Removes `post` as a repost of `match`, tells its author why in a comment,
 * and leaves a note for the moderators. `since` is as in findOriginal.
 */
async function removeAsRepost(
  post: IncomingPost,
  match: Candidate,
  search: Search,
  since: number,
  settings: Settings,
  deps: Deps,
  afterEdit = false
): Promise<void> {
  const { store, reddit } = deps;
  await reddit.remove(post.id);

  const ageMs = since - match.at;
  if (settings.leaveComment) {
    const template = search.originalRemoved ? settings.removedOriginalMessage : settings.removalMessage;
    const text = renderRemovalMessage(template, {
      author: post.authorName,
      reason: match.reason,
      original: permalinkOf(search.info, match.id),
      ageMs,
      cooldownDays: settings.cooldownDays,
      subreddit: post.subredditName,
    });
    try {
      const commentId = await reddit.comment(post.id, text);
      // Remembered so that the comment can be taken off if a moderator approves the post after all.
      if (commentId) {
        const commentKey = `comment:${post.id}`;
        const keptFor = Math.min(settings.cooldownDays * DAY_MS + HOUR_MS, RETENTION_MS);
        await listKeys([commentKey], deps);
        await store.set(commentKey, commentId, { expiration: new Date(deps.now() + keptFor) });
      }
    } catch (error) {
      deps.log?.(`removed ${post.id} but could not comment: ${String(error)}`);
    }
  }
  try {
    // Mod notes are limited to 100 characters.
    const what = match.reason === 'crosspost' ? 'crosspost of' : `same ${match.reason} as`;
    const which = search.originalRemoved ? `${match.id} (removed by a mod)` : match.id;
    const how = afterEdit ? 'edited, ' : '';
    await reddit.addRemovalNote(post.id, `Repost Cooldown: ${how}${what} ${which}, made ${formatAge(ageMs)}`);
  } catch (error) {
    deps.log?.(`removed ${post.id} but could not add a removal note: ${String(error)}`);
  }
}

/**
 * Handles a newly submitted post: removes it when it repeats a post that is
 * still inside the cooldown, otherwise remembers it as an original.
 */
export async function handleNewPost(post: IncomingPost, settings: Settings, deps: Deps): Promise<Outcome> {
  const { store } = deps;
  const cooldownMs = settings.cooldownDays * DAY_MS;

  // Reddit can deliver the same event more than once, even at the same moment.
  // "Set if absent", then read back: only the delivery whose token was stored
  // goes on, so a post is never removed and commented on twice.
  const seenKey = `seen:${post.id}`;
  const token = randomUUID();
  await listKeys([seenKey], deps);
  await store.set(seenKey, token, { nx: true, expiration: new Date(deps.now() + LATE_EVENT_MS) });
  if ((await store.get(seenKey)) !== token) return { action: 'duplicate-event' };

  try {
    // Events arrive late and out of order: the post may already be deleted or
    // removed, or held back by a filter. It is still checked, so that a repost
    // waiting for approval is taken out of the queue, but it is not recorded.
    const gone = Boolean(await store.get(`gone:${post.id}`));

    const prints = fingerprintsOf(post, settings);

    const getInfo = infoReader(deps);
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

    // With the crosspost check switched off, crossposts are allowed: one is
    // not a repost of the very post it shows, whose link and title it carries.
    const allowedId = settings.checkCrossposts ? undefined : parentId;
    const search = await findOriginal(post, candidates, post.createdAt, settings, deps, getInfo, allowedId);
    const { match, replaceable } = search;

    if (!match) {
      const kept = !gone && (await indexPost(post, prints, cooldownMs, deps, { replaceable }));
      return kept ? { action: 'indexed', compared: [...new Set(prints.map((print) => print.kind))] } : { action: 'gone' };
    }
    const found = describe(match, search);

    if (await isExempt(post, settings, deps)) {
      if (!gone) await indexPost(post, prints, cooldownMs, deps, { replaceable });
      return { action: 'exempt', ...found };
    }

    await removeAsRepost(post, match, search, post.createdAt, settings, deps);
    return { action: 'removed', ...found };
  } catch (error) {
    // Let a redelivered event try again.
    await drop(store, seenKey);
    throw error;
  }
}

/**
 * Erases everything the app keeps about a post, for good: the post was
 * deleted by its author or taken down by Reddit, or it was removed in a way
 * that does not count as a moderator's decision. It is no longer an original,
 * so what it contained can be posted again. Returns whether it was recorded.
 */
export async function forgetPost(rawId: string, deps: Pick<Deps, 'store' | 'now'>): Promise<boolean> {
  const id = toPostId(rawId);
  if (!id) return false;
  const { store } = deps;
  // Written before anything is erased: whatever is recording this post at the
  // same moment looks for this after its last write, and erases what it wrote.
  const goneKey = `gone:${id}`;
  await listKeys([goneKey], deps);
  await store.set(goneKey, '1', { expiration: new Date(deps.now() + LATE_EVENT_MS) });
  const recordKey = `post:${id}`;
  const removedKey = `removed:${id}`;
  const record = readRecord(await store.get(recordKey));
  if (record) await release(id, record.keys, store);
  await drop(store, recordKey, removedKey);
  await store.zRem(RECORDED, [id]);
  return record !== undefined;
}

/** Erases many posts for good. Returns how many of them were recorded. */
export async function forgetPosts(ids: string[], deps: Pick<Deps, 'store' | 'now'>): Promise<number> {
  let recorded = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const results = await Promise.all(ids.slice(i, i + BATCH).map((id) => forgetPost(id, deps)));
    recorded += results.filter(Boolean).length;
  }
  return recorded;
}

/**
 * Deals with the posts that Reddit lists as removed. One that a moderator
 * removed stays recorded, as long as the subreddit wants that and its record
 * has not run out; the others are erased. Returns the ids that stay, and how
 * many recorded posts were erased.
 */
export async function forgetRemoved(
  ids: string[],
  settings: Settings,
  deps: Pick<Deps, 'store' | 'now'>
): Promise<{ kept: string[]; erased: number }> {
  const { store } = deps;
  const kept: string[] = [];
  let erased = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    await Promise.all(
      ids.slice(i, i + BATCH).map(async (id) => {
        const [mark, record] = await Promise.all([store.get(`removed:${id}`), store.get(`post:${id}`)]);
        if (settings.checkRemovedPosts && mark && record) kept.push(id);
        // Nothing stored for it means nothing to erase: most removed posts in the list are like that.
        else if ((mark || record) && (await forgetPost(id, deps))) erased++;
      })
    );
  }
  return { kept, erased };
}

/**
 * A moderator, a person, removed a post, and it stays recorded so that
 * posting it again is removed too. Returns whether the post is now remembered
 * as removed. Call this only when the subreddit has the option switched on.
 *
 * From here on the app goes by what Reddit tells it about the post, and by
 * time. It stops counting when:
 *   - a moderator approves it (Reddit reports that);
 *   - Reddit sends a delete event for it, from its author or from Reddit;
 *   - the app reads it for another reason, such as an edit, and finds it
 *     deleted;
 *   - its cooldown ends, and 30 days after this removal at the latest.
 * Reddit sends no delete event when the author of a removed post deletes it.
 * The app does not ask Reddit about such a post when something repeats it, and
 * its daily pass leaves it alone, so until then it keeps counting. That is
 * what stops someone from deleting a removed post only to post it again.
 */
export async function handlePostRemovedByModerator(rawId: string, settings: Settings, deps: Deps): Promise<boolean> {
  const id = toPostId(rawId);
  if (!id) return false;
  const { store, reddit } = deps;
  const now = deps.now();
  const cooldownMs = settings.cooldownDays * DAY_MS;
  const goneKey = `gone:${id}`;

  // The event says the post was removed, but events arrive late and out of
  // order: a moderator may have approved it again since, or its author may
  // have deleted it. So the post is read from Reddit, which a moderator can
  // still do for a removed post.
  let madeAt = readRecord(await store.get(`post:${id}`))?.at;
  const found = await reddit.getPost(id).catch((error: unknown) => {
    deps.log?.(`${id} was removed by a moderator but could not be read: ${String(error)}`);
    return undefined;
  });
  if (found?.state === 'deleted') await forgetPost(id, deps);
  if (found && found.state !== 'removed') return false;
  if (madeAt === undefined) {
    // Not recorded: a filter held it back when it came in, or the app never
    // saw it. Without being able to read it there is nothing to record.
    if (!found || found.post.createdAt + cooldownMs <= now) return false;
    await drop(store, goneKey);
    if (!(await indexPost(found.post, fingerprintsOf(found.post, settings), cooldownMs, deps))) return false;
    madeAt = found.post.createdAt;
  }

  const expiresAt = Math.min(madeAt + cooldownMs + HOUR_MS, now + RETENTION_MS);
  if (expiresAt <= now) return false;
  const removedKey = `removed:${id}`;
  await listKeys([removedKey], deps);
  await store.set(removedKey, '1', { expiration: new Date(expiresAt) });
  // Its author may have deleted it at this very moment. Then nothing stays.
  if (await store.get(goneKey)) {
    await drop(store, removedKey);
    return false;
  }
  return true;
}

/**
 * Erases everything the app has stored for the subreddit: every key on the
 * list of keys it has written, then the lists themselves. Returns how many
 * keys there were to erase.
 *
 * It does not switch the app off. A post that comes in afterwards is recorded
 * as usual, and the next daily pass records the posts that are up.
 */
export async function eraseEverything(deps: Pick<Deps, 'store'>): Promise<number> {
  const { store } = deps;
  const PAGE = 500;
  let erased = 0;
  // Each round takes the first names off the list, so this ends when it is empty.
  for (let round = 0; round < 100_000; round++) {
    const names = (await store.zRange(KEYS, 0, PAGE - 1, { by: 'rank' })).map((entry) => entry.member);
    if (names.length === 0) break;
    erased += await store.exists(...names);
    await store.del(...names);
    await store.zRem(KEYS, names);
  }
  erased += await store.exists(RECORDED);
  await store.del(RECORDED, KEYS);
  return erased;
}

/**
 * Erases the recorded posts that Reddit no longer lists. `listed` holds the
 * posts in Reddit's list of the subreddit's newest posts that may stay
 * recorded, and the list was read back to the time `from`. A recorded post
 * made since then that is not among them was deleted, or removed, and no
 * event said so.
 *
 * Posts made after `until` are left alone, because the list may not show a
 * post in its first minutes. So are posts made before `from`: the list did
 * not reach them, which says nothing about them.
 *
 * A post that a moderator removed is left alone too, where the subreddit has
 * that option on. For such a post the app goes by Reddit's events and by its
 * 30 days, and does not go looking: see handlePostRemovedByModerator.
 *
 * Returns how many recorded posts were erased.
 */
export async function forgetUnlisted(
  listed: ReadonlySet<string>,
  from: number,
  until: number,
  settings: Settings,
  deps: Pick<Deps, 'store' | 'now'>
): Promise<number> {
  if (!(from <= until)) return 0;
  const { store } = deps;
  const recorded = await store.zRange(RECORDED, from, until, { by: 'score' });
  const missing = recorded.map((entry) => entry.member).filter((id) => !listed.has(id));
  if (!settings.checkRemovedPosts) return forgetPosts(missing, deps);

  const unmarked: string[] = [];
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const marks = await Promise.all(batch.map((id) => store.get(`removed:${id}`)));
    batch.forEach((id, index) => {
      if (!marks[index]) unmarked.push(id);
    });
  }
  return forgetPosts(unmarked, deps);
}

/**
 * Re-reads a post that was edited: gives up what it no longer contains and
 * records what it contains now, so that nothing is kept of a link or text
 * that is no longer there.
 *
 * An edit can also turn a post into a repost: its author posts something
 * else, then edits in the text or the link of another post. Whatever the edit
 * added that another post already has is checked the way a new post is, and a
 * match gets the edited post removed. What the post was recorded with before
 * the edit is not checked again, so a post that a moderator approved, or one
 * by a moderator, is not removed for what it already said.
 *
 * `textUnchanged` says that the event shows the same text before and after.
 * The settings are only asked for when the post has to be read again.
 */
export async function handlePostEdited(
  post: IncomingPost,
  loadSettings: () => Promise<Settings>,
  deps: Deps,
  textUnchanged = false
): Promise<EditOutcome> {
  const { store, reddit } = deps;
  // A post the app removed, one that was erased, one past the cooldown, or one
  // it never saw has no record.
  const recordKey = `post:${post.id}`;
  const record = readRecord(await store.get(recordKey));
  if (!record) return { action: 'ignored' };

  /** The post as it is on Reddit now, or `undefined` when it cannot be read. */
  const readNow = (otherwise: string) =>
    reddit.getPost(post.id).catch((error: unknown) => {
      deps.log?.(`${post.id} was edited but could not be read, so ${otherwise}: ${String(error)}`);
      return undefined;
    });
  // The post keeps the age it was recorded with; an edit does not restart its cooldown.
  const recordAs = (edited: IncomingPost, prints: Fingerprint[], settings: Settings, replaceable?: ReadonlySet<string>) =>
    indexPost({ ...edited, createdAt: record.at }, prints, settings.cooldownDays * DAY_MS, deps, { replaceable });

  if (await store.get(`removed:${post.id}`)) {
    // A moderator removed this post. Reddit may blank out the text of a
    // removed post in the event, so the post is read from Reddit itself. If
    // that fails there is no telling what the post says now, and it is erased
    // rather than kept as it was.
    const found = await readNow('it is erased');
    if (!found || found.state === 'deleted') {
      await forgetPost(post.id, deps);
      return { action: 'gone' };
    }
    // It is down already, so there is nothing to remove.
    const settings = await loadSettings();
    const kept = await recordAs(found.post, fingerprintsOf(found.post, settings), settings);
    return { action: kept ? 'recorded' : 'gone' };
  }
  // A post's title and link cannot be edited, so nothing it is compared by has changed.
  if (textUnchanged) return { action: 'ignored' };

  const settings = await loadSettings();
  const had = new Set(record.keys);
  /** The posts that already have something the edit put into this one. */
  const copiedFrom = async (prints: Fingerprint[]): Promise<Candidate[]> => {
    const candidates: Candidate[] = [];
    for (const print of prints) {
      if (had.has(print.key)) continue;
      const entry = readEntry(await store.get(print.key));
      if (entry && entry.id !== post.id) candidates.push({ reason: print.kind, id: entry.id, at: entry.at, key: print.key });
    }
    return candidates;
  };

  let edited = post;
  let prints = fingerprintsOf(edited, settings);
  let candidates = await copiedFrom(prints);
  if (candidates.length > 0) {
    // The edit seems to copy another post. Events arrive late and out of
    // order, and this one may show a text the post no longer has, so before
    // anything is removed the post is read from Reddit: what it says now
    // decides. If it cannot be read, it is not removed on a guess.
    const found = await readNow('it is not checked for a repost');
    if (found?.state === 'deleted') {
      await forgetPost(post.id, deps);
      return { action: 'gone' };
    }
    if (found) {
      // Only the text can change in an edit. The event may lack the author's name.
      edited = { ...post, body: found.post.body ?? '', authorName: post.authorName || found.post.authorName };
      prints = fingerprintsOf(edited, settings);
    }
    // A post that is down already is not removed a second time.
    candidates = found?.state === 'up' ? await copiedFrom(prints) : [];
  }

  // The time that counts is now: this is when the post came to say what it says.
  const now = deps.now();
  const search = await findOriginal(edited, candidates, now, settings, deps, infoReader(deps));
  const { match, replaceable } = search;
  if (!match) return { action: (await recordAs(edited, prints, settings, replaceable)) ? 'recorded' : 'gone' };
  const found = describe(match, search);

  if (await isExempt(edited, settings, deps)) {
    await recordAs(edited, prints, settings, replaceable);
    return { action: 'exempt', ...found };
  }

  // Reddit can deliver the same event more than once, even at the same moment.
  // "Set if absent", then read back: only the delivery whose token was stored
  // goes on, so the post is never removed and commented on twice.
  const claimKey = `editing:${post.id}`;
  const token = randomUUID();
  await listKeys([claimKey], deps);
  await store.set(claimKey, token, { nx: true, expiration: new Date(now + CLAIM_MS) });
  if ((await store.get(claimKey)) !== token) return { action: 'duplicate-event' };
  try {
    // A delivery that was here before this one erased the record when it was done.
    if (!(await store.get(recordKey))) return { action: 'duplicate-event' };
    await removeAsRepost(edited, match, search, now, settings, deps, true);
    // It is down now, removed by an app, so nothing of it is kept. This comes
    // last: if the removal fails, the record is still there for the event to
    // be handled again.
    await forgetPost(post.id, deps);
  } finally {
    await drop(store, claimKey);
  }
  return { action: 'removed', ...found };
}

/**
 * A moderator approved a post, so it is up again and an ordinary post: a mark
 * that a moderator had removed it is dropped. If the app had removed it as a
 * repost, the app's comment saying so is no longer true and is deleted. If the
 * post is not recorded, because it was erased when it was removed or was never
 * seen, it is read from Reddit and recorded: it counts as an original from now
 * on. An approved post is never removed.
 *
 * The settings are only asked for when the post has to be recorded.
 */
export async function handlePostApproved(
  rawId: string,
  loadSettings: () => Promise<Settings>,
  deps: Deps
): Promise<{ unmarked: boolean; recorded: boolean; commentDeleted: boolean }> {
  const result = { unmarked: false, recorded: false, commentDeleted: false };
  const id = toPostId(rawId);
  if (!id) return result;
  const { store, reddit } = deps;

  const removedKey = `removed:${id}`;
  if (await store.get(removedKey)) {
    await drop(store, removedKey);
    result.unmarked = true;
  }

  const commentKey = `comment:${id}`;
  const commentId = await store.get(commentKey);
  if (commentId) {
    try {
      await reddit.deleteComment(commentId);
      result.commentDeleted = true;
    } catch (error) {
      deps.log?.(`${id} was approved but the removal comment could not be deleted: ${String(error)}`);
    }
    await drop(store, commentKey);
  }

  // A moderator has decided the post stays, so a submit event for it that
  // arrives only now must not get it checked and removed.
  const seenKey = `seen:${id}`;
  await listKeys([seenKey], deps);
  await store.set(seenKey, 'approved', { expiration: new Date(deps.now() + LATE_EVENT_MS) });

  if (readRecord(await store.get(`post:${id}`))) return result;
  // Asked of Reddit rather than taken from the event: the post may have been
  // removed again, or deleted, since it was approved.
  const found = await reddit.getPost(id);
  if (found.state !== 'up') return result;
  const settings = await loadSettings();
  const cooldownMs = settings.cooldownDays * DAY_MS;
  if (found.post.createdAt + cooldownMs <= deps.now()) return result;
  await drop(store, `gone:${id}`);
  result.recorded = await indexPost(found.post, fingerprintsOf(found.post, settings), cooldownMs, deps);
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
  // The two lists do not expire by themselves the way keys do: entries for
  // posts past the cooldown, and for keys that are certain to be gone, go here.
  await deps.store.zRemRangeByScore(RECORDED, 0, now - cooldownMs - DAY_MS);
  await deps.store.zRemRangeByScore(KEYS, 0, now);
  return recorded;
}
