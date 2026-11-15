/**
 * Devvit entry point. Reddit calls these endpoints (declared in devvit.json)
 * when a post is submitted, edited or deleted, when a moderator removes or
 * approves one, when the app is installed or updated, and when a moderator
 * picks the rescan menu item. The rules live in ../core/cooldown.ts.
 */
import type { IncomingMessage } from 'node:http';
import { context, createServer, getServerPort, reddit, redis, settings } from '@devvit/web/server';
import type {
  MenuItemRequest,
  OnModActionRequest,
  OnPostDeleteRequest,
  OnPostSubmitRequest,
  OnPostUpdateRequest,
  UiResponse,
} from '@devvit/web/shared';
import {
  handleNewPost,
  handlePostApproved,
  handlePostDeleted,
  handlePostEdited,
  handlePostRemovedByModerator,
  indexExistingPosts,
  parseSettings,
  toMillis,
  type Deps,
  type IncomingPost,
  type RedditGateway,
  type Settings,
} from '../core/cooldown.ts';
import { toPostId } from '../core/normalize.ts';

type PostId = `t3_${string}`;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How Reddit's events say "deleted by its author" and "this account is a person, not an app". */
const DELETED_BY_AUTHOR = 1;
const PERSON = 1;

/** True when an event field holds the given value, written as a number or by its name. */
function holds(value: unknown, number: number, name: string): boolean {
  return Number(value) === number || value === name;
}

function log(message: string): void {
  console.log(`[repost-cooldown] ${message}`);
}

const gateway: RedditGateway = {
  async getPostInfo(id) {
    const post = await reddit.getPostById(id as PostId);
    return {
      id: post.id,
      subredditId: post.subredditId,
      createdAt: post.createdAt.getTime(),
      removed:
        post.removed || post.spam || Boolean(post.removedByCategory) || post.authorName === '[deleted]',
      permalink: post.permalink,
    };
  },
  async isModerator(username) {
    const found = await reddit.getModerators({ subredditName: context.subredditName, username }).all();
    return found.length > 0;
  },
  async remove(id) {
    await reddit.remove(id as PostId, false);
  },
  async comment(id, text) {
    const comment = await reddit.submitComment({ id: id as PostId, text });
    try {
      await comment.distinguish(true);
    } catch (error) {
      // The comment is there; it is only not pinned to the top.
      log(`commented on ${id} but could not pin the comment: ${String(error)}`);
    }
  },
  async addRemovalNote(id, note) {
    await reddit.addRemovalNote({ itemIds: [id], reasonId: '', modNote: note.slice(0, 100) });
  },
};

function deps(): Deps {
  return {
    store: redis,
    reddit: gateway,
    now: () => Date.now(),
    // The app's account is named after the app.
    exemptAuthors: [context.appSlug],
    log,
  };
}

/**
 * The moderators' settings. Throws when they cannot be read: carrying on with
 * the defaults could remove posts under rules the moderators have switched off.
 */
async function loadSettings(): Promise<Settings> {
  return parseSettings(await settings.getAll<Record<string, unknown>>());
}

/** The post in a submit or edit event, or `undefined` when the event carries none. */
function incomingPost(event: Pick<OnPostSubmitRequest, 'post' | 'author' | 'subreddit'>): IncomingPost | undefined {
  const id = toPostId(event.post?.id);
  if (!event.post || !id) return undefined;
  return {
    id,
    title: event.post.title ?? '',
    url: event.post.url ?? '',
    body: event.post.selftext ?? '',
    isSelf: event.post.isSelf === true,
    authorName: event.author?.name ?? '',
    createdAt: toMillis(event.post.createdAt, Date.now()),
    crosspostParentId: event.post.crosspostParentId || undefined,
    subredditId: event.post.subredditId || event.subreddit?.id || context.subredditId,
    subredditName: event.subreddit?.name || context.subredditName,
  };
}

async function onPostSubmit(event: OnPostSubmitRequest): Promise<void> {
  const post = incomingPost(event);
  if (!post) return;
  const current = await loadSettings();
  const outcome = await handleNewPost(post, current, deps());
  // One line per post, so the app's log explains every decision. Post ids
  // only: no usernames, links or text from the subreddits that install the app.
  const who = post.id;
  if (outcome.action === 'removed' || outcome.action === 'exempt') {
    const original = outcome.originalRemoved ? `${outcome.originalId}, which a moderator removed` : outcome.originalId;
    log(`${who}: ${outcome.action} (${outcome.reason} match with ${original})`);
  } else if (outcome.action === 'indexed') {
    const kind = post.isSelf ? 'text post' : 'link post';
    log(
      `${who}: kept, ${kind}, compared by [${outcome.compared.join(', ') || 'nothing'}], ` +
        `cooldown ${current.cooldownDays}d, min title ${current.minTitleLength}, min text ${current.minTextLength}`
    );
  } else {
    log(`${who}: event already handled`);
  }
}

/** An edit can add or take away the links and text a post is compared by. */
async function onPostUpdate(event: OnPostUpdateRequest): Promise<void> {
  const post = incomingPost(event);
  if (!post) return;
  if (await handlePostEdited(post, await loadSettings(), deps())) log(`${post.id}: edited, recorded again`);
}

async function onPostDelete(event: OnPostDeleteRequest): Promise<void> {
  // Reddit sends this for removals as well. Only a deletion by the author frees
  // a post at once; a removed post is looked at when something repeats it.
  if (!holds(event.source, DELETED_BY_AUTHOR, 'USER')) return;
  await handlePostDeleted(event.postId, { store: redis });
}

/**
 * A moderator removing a post is a decision about that post, so posting it
 * again is removed too. Only a person's removal counts: AutoModerator and
 * other apps often remove a post because of who posted it or how often, and
 * the same post from someone else, or later, may be fine.
 */
async function onModAction(event: OnModActionRequest): Promise<void> {
  const id = toPostId(event.targetPost?.id);
  if (!id) return;
  if (event.action === 'approvelink') {
    if (await handlePostApproved(id, { store: redis })) log(`${id}: approved, an ordinary post again`);
    return;
  }
  if (event.action !== 'removelink' && event.action !== 'spamlink') return;

  const name = (event.moderator?.name ?? '').toLowerCase();
  // The app's own removals are reposts, which were never originals.
  if (name === context.appSlug.toLowerCase()) return;
  const accountType = event.moderator?.accountType;
  if (!holds(accountType, PERSON, 'ACCOUNT_TYPE_USER') || name === 'automoderator') {
    log(`${id}: removed by AutoModerator or an app (account type ${String(accountType)}), not counted`);
    return;
  }
  if (await handlePostRemovedByModerator(id, { store: redis, now: () => Date.now() })) {
    log(`${id}: removed by a moderator, so posting it again is removed too`);
  }
}

/** Reads the subreddit's newest posts (Reddit lists at most 1000) and records them. */
async function rescan(): Promise<number> {
  const subredditName = context.subredditName;
  // Recording removes nothing, so the defaults are a safe stand-in when the settings cannot be read.
  const current = await loadSettings().catch((error: unknown) => {
    log(`could not read the settings, recording with the defaults: ${String(error)}`);
    return parseSettings(undefined);
  });
  const oldest = Date.now() - current.cooldownDays * DAY_MS;
  const posts: IncomingPost[] = [];
  // The listing is newest first, so reading stops at the first post that is past the cooldown.
  for await (const post of reddit.getNewPosts({ subredditName, limit: 1000, pageSize: 100 })) {
    if (post.createdAt.getTime() < oldest) break;
    if (post.removed || post.spam || post.removedByCategory || post.authorName === '[deleted]') continue;
    posts.push({
      id: post.id,
      title: post.title,
      url: post.url,
      body: post.body ?? '',
      authorName: post.authorName,
      createdAt: post.createdAt.getTime(),
      crosspostParentId: post.crosspostParentId,
      subredditId: post.subredditId,
      subredditName,
    });
  }
  return indexExistingPosts(posts, current, deps());
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return (text ? JSON.parse(text) : {}) as T;
}

async function route(req: IncomingMessage): Promise<object | undefined> {
  const path = (req.url ?? '').split('?')[0];
  switch (path) {
    case '/internal/triggers/post-submit':
      await onPostSubmit(await readJson<OnPostSubmitRequest>(req));
      return {};
    case '/internal/triggers/post-update':
      await onPostUpdate(await readJson<OnPostUpdateRequest>(req));
      return {};
    case '/internal/triggers/post-delete':
      await onPostDelete(await readJson<OnPostDeleteRequest>(req));
      return {};
    case '/internal/triggers/mod-action':
      await onModAction(await readJson<OnModActionRequest>(req));
      return {};
    case '/internal/triggers/app-install':
    case '/internal/triggers/app-upgrade': {
      const count = await rescan();
      const what = path.endsWith('app-install') ? 'installed' : 'updated';
      log(`${what} in r/${context.subredditName}; recorded ${count} existing posts`);
      return {};
    }
    case '/internal/menu/rescan': {
      await readJson<MenuItemRequest>(req);
      const count = await rescan();
      const response: UiResponse = {
        showToast: { text: `Repost Cooldown now knows ${count} recent posts.`, appearance: 'success' },
      };
      return response;
    }
    default:
      return undefined;
  }
}

const server = createServer(async (req, res) => {
  let status = 200;
  let body: object;
  try {
    const result = await route(req);
    if (result) {
      body = result;
    } else {
      status = 404;
      body = { status: 'error', message: 'not found' };
    }
  } catch (error) {
    console.error(`[repost-cooldown] ${req.url} failed:`, error);
    status = 500;
    body = { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  // Devvit rejects a response that has a body but no Content-Length.
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': payload.byteLength });
  res.end(payload);
});

server.on('error', (error) => console.error('[repost-cooldown] server error:', error));
server.listen(getServerPort());
