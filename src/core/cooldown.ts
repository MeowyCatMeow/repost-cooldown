/**
 * Repost Cooldown's decision logic. It has no Devvit imports: storage and the
 * Reddit API are passed in, so the rules can be tested without Reddit.
 *
 * Storage layout (Devvit Redis is already separate per subreddit):
 *   fp:link:<hash>   -> {"id","at"}    the post that currently owns this link
 *   fp:title-only:<hash> -> {"id","at"} the textless post that currently owns this title
 *   fp:title-text:<hash> -> {"id","at"} the post that currently owns this title and text
 *   fp:text:<hash>   -> {"id","at"}    the post that currently owns this body text
 *   post:<id>        -> {"at","keys"}  a known post and the fingerprints it owns
 *   seen:<id>        -> a token        the post's submit event is being, or was, handled
 *   removed:<id>     -> "1"            a moderator took the post down; it still counts as an original
 * Every key expires on its own once its post is older than the cooldown; a
 * "removed" mark expires once its post is older than the longest cooldown.
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

export type Settings = {
  cooldownDays: number;
  /** A post that a moderator removed still counts as an original. */
  checkRemovedPosts: boolean;
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
  checkRemovedPosts: true,
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
  return {
    cooldownDays: num('cooldownDays', 1, MAX_COOLDOWN_DAYS),
    checkRemovedPosts: bool('checkRemovedPosts'),
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
  isModerator(username: string): Promise<boolean>;
  remove(id: string): Promise<void>;
  /** Posts a comment on the post, as a stickied moderator comment. */
  comment(id: string, text: string): Promise<void>;
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

/** `originalRemoved` is set when the original is a post that a moderator took down. */
export type Outcome =
  | { action: 'duplicate-event' }
  | { action: 'indexed'; compared: Array<Fingerprint['kind']> }
  | { action: 'exempt'; reason: Reason; originalId: string; originalRemoved?: true }
  | { action: 'removed'; reason: Reason; originalId: string; originalRemoved?: true };

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

/**
 * Records `post` as the owner of each fingerprint that is free. A fingerprint
 * in `replaceable` is taken over even though it has an owner, because that
 * owner is past the cooldown or no longer exists.
 */
async function indexPost(
  post: IncomingPost,
  prints: Fingerprint[],
  cooldownMs: number,
  replaceable: ReadonlySet<string>,
  deps: Deps
): Promise<void> {
  // An hour of slack so a key never disappears just before its cooldown ends.
  const expiresAt = post.createdAt + cooldownMs + HOUR_MS;
  if (expiresAt <= deps.now()) return;
  const expiration = new Date(expiresAt);
  const value = JSON.stringify({ id: post.id, at: post.createdAt } satisfies Entry);

  const owned: string[] = [];
  for (const print of prints) {
    if (replaceable.has(print.key)) {
      await deps.store.set(print.key, value, { expiration });
      owned.push(print.key);
      continue;
    }
    // "Set if absent", then read back: only one of two simultaneous posts wins.
    await deps.store.set(print.key, value, { nx: true, expiration });
    const current = readEntry(await deps.store.get(print.key));
    if (current?.id === post.id) owned.push(print.key);
  }
  const record: PostRecord = { at: post.createdAt, keys: owned };
  await deps.store.set(`post:${post.id}`, JSON.stringify(record), { expiration });
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
  await store.set(seenKey, token, { nx: true, expiration: new Date(deps.now() + 2 * DAY_MS) });
  if ((await store.get(seenKey)) !== token) return { action: 'duplicate-event' };

  try {
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
    /** The original is a post that a moderator took down. */
    let originalRemoved = false;
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
      // A post that is still up counts as an original, and so does one that a
      // moderator took down, when the subreddit wants that. When neither can
      // be confirmed, leave the new post alone rather than remove it on a guess.
      const info = await getInfo(candidate.id);
      if (!info) continue;
      if (info.removed) {
        if (settings.checkRemovedPosts && (await store.get(`removed:${candidate.id}`))) {
          match = candidate;
          originalRemoved = true;
          break;
        }
        // Deleted by its author, or removed by AutoModerator, Reddit or another app: free again.
        if (candidate.key) replaceable.add(candidate.key);
        continue;
      }
      match = candidate;
      break;
    }

    if (!match) {
      await indexPost(post, prints, cooldownMs, replaceable, deps);
      return { action: 'indexed', compared: [...new Set(prints.map((print) => print.kind))] };
    }
    const found = { reason: match.reason, originalId: match.id, ...(originalRemoved ? { originalRemoved: true as const } : {}) };

    if (await isExempt(post, settings, deps)) {
      await indexPost(post, prints, cooldownMs, replaceable, deps);
      return { action: 'exempt', ...found };
    }

    await reddit.remove(post.id);

    const ageMs = post.createdAt - match.at;
    if (settings.leaveComment) {
      const template = originalRemoved ? settings.removedOriginalMessage : settings.removalMessage;
      const text = renderRemovalMessage(template, {
        author: post.authorName,
        reason: match.reason,
        original: permalinkOf(infoCache.get(match.id), match.id),
        ageMs,
        cooldownDays: settings.cooldownDays,
        subreddit: post.subredditName,
      });
      try {
        await reddit.comment(post.id, text);
      } catch (error) {
        deps.log?.(`removed ${post.id} but could not comment: ${String(error)}`);
      }
    }
    try {
      // Mod notes are limited to 100 characters.
      const what = match.reason === 'crosspost' ? 'crosspost of' : `same ${match.reason} as`;
      const which = originalRemoved ? `${match.id} (removed by a mod)` : match.id;
      await reddit.addRemovalNote(post.id, `Repost Cooldown: ${what} ${which}, made ${formatAge(ageMs)}`);
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
 * Forgets a post that its author deleted, so its link and title are free
 * again. A post that a moderator took down is kept: deleting it afterwards
 * must not make it postable again.
 */
export async function handlePostDeleted(rawId: string, deps: Pick<Deps, 'store'>): Promise<void> {
  const id = toPostId(rawId);
  if (!id) return;
  if (await deps.store.get(`removed:${id}`)) return;
  const recordKey = `post:${id}`;
  const record = readRecord(await deps.store.get(recordKey));
  if (!record) return;
  for (const key of record.keys) {
    const entry = readEntry(await deps.store.get(key));
    if (entry?.id === id) await deps.store.del(key);
  }
  await deps.store.del(recordKey);
}

/**
 * Re-reads a post that was edited: gives up what it no longer contains and
 * records what it contains now, so that nothing is removed for repeating a
 * link or text that is no longer there. An edit never gets a post removed.
 * Returns whether the post is one the app keeps track of.
 */
export async function handlePostEdited(post: IncomingPost, settings: Settings, deps: Deps): Promise<boolean> {
  // A post the app removed, one past the cooldown, or one it never saw has no record.
  const record = readRecord(await deps.store.get(`post:${post.id}`));
  if (!record) return false;
  // A post that a moderator took down stays recorded as it was when that
  // happened: editing it must not make its link or text postable again.
  if (await deps.store.get(`removed:${post.id}`)) return false;

  const prints = fingerprintsOf(post, settings);
  const kept = new Set(prints.map((print) => print.key));
  for (const key of record.keys) {
    if (kept.has(key)) continue;
    const entry = readEntry(await deps.store.get(key));
    if (entry?.id === post.id) await deps.store.del(key);
  }
  // The post keeps the age it was recorded with; an edit does not restart its cooldown.
  await indexPost({ ...post, createdAt: record.at }, prints, settings.cooldownDays * DAY_MS, new Set(), deps);
  return true;
}

/**
 * Remembers that a moderator took a post down. From then on the post still
 * counts as an original, so posting it again is caught, even after its author
 * deletes or edits it. Returns whether the post is one the app keeps track of.
 */
export async function handlePostRemovedByModerator(rawId: string, deps: Pick<Deps, 'store' | 'now'>): Promise<boolean> {
  const id = toPostId(rawId);
  if (!id) return false;
  // A post the app removed itself, one past the cooldown, or one it never saw has no record.
  const record = readRecord(await deps.store.get(`post:${id}`));
  if (!record) return false;
  // The mark outlives the post's record under any cooldown a subreddit can set.
  const expiresAt = record.at + (MAX_COOLDOWN_DAYS + 1) * DAY_MS;
  if (expiresAt <= deps.now()) return false;
  await deps.store.set(`removed:${id}`, '1', { expiration: new Date(expiresAt) });
  return true;
}

/**
 * A moderator approved a post: if it had been taken down, it is an ordinary
 * post again. Returns whether it had been marked as taken down.
 */
export async function handlePostApproved(rawId: string, deps: Pick<Deps, 'store'>): Promise<boolean> {
  const id = toPostId(rawId);
  if (!id) return false;
  const key = `removed:${id}`;
  if (!(await deps.store.get(key))) return false;
  await deps.store.del(key);
  return true;
}

/**
 * Remembers posts that already exist (used on install and on a manual
 * rescan). Nothing is removed. When several of them share a link or title,
 * the oldest one becomes the original. Returns how many posts were recorded.
 */
export async function indexExistingPosts(posts: IncomingPost[], settings: Settings, deps: Deps): Promise<number> {
  const cooldownMs = settings.cooldownDays * DAY_MS;
  const now = deps.now();
  const recent = posts
    .filter((post) => post.createdAt + cooldownMs > now)
    .sort((a, b) => a.createdAt - b.createdAt);

  // Ownership is decided oldest first: the oldest post with a link or title is the original.
  const owner = new Map<string, string>();
  const perPost: Array<Array<() => Promise<unknown>>> = [];
  for (const post of recent) {
    const expiration = new Date(post.createdAt + cooldownMs + HOUR_MS);
    const value = JSON.stringify({ id: post.id, at: post.createdAt } satisfies Entry);
    const owned: string[] = [];
    const steps: Array<() => Promise<unknown>> = [];
    for (const print of fingerprintsOf(post, settings)) {
      if (owner.has(print.key)) continue;
      owner.set(print.key, post.id);
      owned.push(print.key);
      // "Set if absent" keeps whatever the live trigger has already recorded.
      steps.push(() => deps.store.set(print.key, value, { nx: true, expiration }));
    }
    const record: PostRecord = { at: post.createdAt, keys: owned };
    // Rewritten on every pass, so a rescan after an update picks up new kinds of key.
    steps.push(() => deps.store.set(`post:${post.id}`, JSON.stringify(record), { expiration }));
    perPost.push(steps);
  }
  // Written newest first: if Reddit cuts a long pass short, what is missing is
  // the oldest posts, which have the least of their cooldown left.
  const writes = perPost.reverse().flat();

  const BATCH = 25;
  for (let i = 0; i < writes.length; i += BATCH) {
    await Promise.all(writes.slice(i, i + BATCH).map((write) => write()));
  }
  return recent.length;
}
