/**
 * Devvit entry point. Reddit calls these endpoints (declared in devvit.json)
 * when a post is submitted, edited, deleted or removed, when a moderator
 * approves one, when the app is installed or updated, once a day, and when a
 * moderator picks one of the app's menu items. The rules live in
 * ../core/cooldown.ts.
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
  eraseEverything,
  forgetPost,
  forgetPosts,
  forgetRemoved,
  forgetUnlisted,
  handleNewPost,
  handlePostApproved,
  handlePostEdited,
  handlePostRemovedByModerator,
  indexExistingPosts,
  parseSettings,
  toMillis,
  type Deps,
  type IncomingPost,
  type PostState,
  type RedditGateway,
  type Settings,
} from '../core/cooldown.ts';
import { toPostId } from '../core/normalize.ts';

type PostId = `t3_${string}`;
/** A post as Reddit's API returns it. */
type RedditPost = Awaited<ReturnType<typeof reddit.getPostById>>;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A post made in the last few minutes may not be in Reddit's list of newest posts yet. */
const LISTING_LAG_MS = 10 * 60 * 1000;
/** The form that asks a moderator to confirm the erasing; devvit.json names it too. */
const ERASE_FORM = 'eraseForm';

/**
 * How Reddit's events say who took a post down, and what kind of account a
 * moderator is. Reddit sends such a value as a number or by its name.
 */
const BY_AUTHOR = [1, 'USER'] as const;
const BY_REDDIT = [2, 'ADMIN'] as const;
const BY_MODERATOR = [3, 'MODERATOR'] as const;
const PERSON = [1, 'ACCOUNT_TYPE_USER'] as const;

function holds(value: unknown, [number, name]: readonly [number, string]): boolean {
  return Number(value) === number || value === name;
}

function log(message: string): void {
  console.log(`[repost-cooldown] ${message}`);
}

function stateOf(post: RedditPost): PostState {
  // A deleted post has lost its author. So has a post whose author deleted
  // their account, and the app treats that one the same way.
  if (post.authorName === '[deleted]' || post.removedByCategory === 'deleted') return 'deleted';
  // Removed, marked as spam, or held back by a filter.
  return post.removed || post.spam || post.removedByCategory ? 'removed' : 'up';
}

function fromReddit(post: RedditPost): IncomingPost {
  return {
    id: post.id,
    title: post.title,
    url: post.url,
    body: post.body ?? '',
    authorName: post.authorName,
    createdAt: post.createdAt.getTime(),
    crosspostParentId: post.crosspostParentId,
    subredditId: post.subredditId,
    subredditName: context.subredditName,
  };
}

const gateway: RedditGateway = {
  async getPostInfo(id) {
    const post = await reddit.getPostById(id as PostId);
    return {
      id: post.id,
      subredditId: post.subredditId,
      createdAt: post.createdAt.getTime(),
      state: stateOf(post),
      permalink: post.permalink,
    };
  },
  async getPost(id) {
    const post = await reddit.getPostById(id as PostId);
    return { state: stateOf(post), post: fromReddit(post) };
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
    return comment.id;
  },
  async deleteComment(commentId) {
    const comment = await reddit.getCommentById(commentId as `t1_${string}`);
    await comment.delete();
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
  } else if (outcome.action === 'gone') {
    log(`${who}: already deleted or removed, nothing recorded`);
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
  const textUnchanged = (event.previousBody ?? '') === (post.body ?? '');
  if (await handlePostEdited(post, loadSettings, deps(), textUnchanged)) log(`${post.id}: edited, recorded again`);
}

/**
 * Reddit sends this when a post is deleted by its author, when Reddit takes it
 * down, and when a moderator removes it. The first two erase the post at once,
 * whatever happened to it before. A moderator's removal is not decided here:
 * the moderator action that follows says who removed it.
 */
async function onPostDelete(event: OnPostDeleteRequest): Promise<void> {
  const id = toPostId(event.postId);
  if (!id || holds(event.source, BY_MODERATOR)) return;
  if (!holds(event.source, BY_AUTHOR) && !holds(event.source, BY_REDDIT)) {
    // Reddit did not say who did it, so the app looks at what became of the
    // post. A removal is left to the moderator action and the daily check.
    // A post that can no longer be read at all is treated as deleted.
    const state = await gateway.getPostInfo(id).then(
      (info) => info.state,
      () => 'deleted' as const
    );
    if (state !== 'deleted') return;
  }
  if (await forgetPost(id, deps())) log(`${id}: deleted, or taken down by Reddit: erased`);
}

/**
 * A moderator removing a post is a decision about that post, so the post stays
 * recorded and posting it again is removed too. Only a person's removal
 * counts: AutoModerator and other apps often remove a post because of who
 * posted it or how often, and the same post from someone else, or later, may
 * be fine. A post they remove is erased.
 */
async function onModAction(event: OnModActionRequest): Promise<void> {
  const id = toPostId(event.targetPost?.id);
  if (!id) return;
  if (event.action === 'approvelink') {
    const approved = await handlePostApproved(id, loadSettings, deps());
    if (approved.unmarked) log(`${id}: approved, an ordinary post again`);
    if (approved.commentDeleted) log(`${id}: approved after the app removed it, removal comment deleted`);
    if (approved.recorded) log(`${id}: approved, recorded again`);
    return;
  }
  if (event.action !== 'removelink' && event.action !== 'spamlink') return;

  const name = (event.moderator?.name ?? '').toLowerCase();
  const person =
    holds(event.moderator?.accountType, PERSON) && name !== 'automoderator' && name !== context.appSlug.toLowerCase();
  if (person) {
    const current = await loadSettings();
    // A bot that runs under an ordinary account looks like a person; the
    // moderators can name such accounts in the settings.
    if (current.checkRemovedPosts && !current.ignoredRemovers.includes(name)) {
      if (await handlePostRemovedByModerator(id, current, deps())) {
        log(`${id}: removed by a moderator, so posting it again is removed too`);
      }
      return;
    }
  }
  if (await forgetPost(id, deps())) log(`${id}: removed, erased`);
}

/** Recording removes nothing, so the defaults are a safe stand-in when the settings cannot be read. */
async function settingsOrDefaults(): Promise<Settings> {
  return loadSettings().catch((error: unknown) => {
    log(`could not read the settings, recording with the defaults: ${String(error)}`);
    return parseSettings(undefined);
  });
}

/**
 * Reads the subreddit's newest posts (Reddit lists at most 1000) and brings
 * what the app has recorded in line with it. Posts that are up are recorded.
 * Removed posts are erased. And a post that is recorded but missing from the
 * list is erased: that is how a post shows that was deleted without the app
 * being told.
 *
 * Posts that a moderator removed are the exception, where the subreddit has
 * that option on: they are left as they are, listed or not.
 */
async function rescan(current: Settings): Promise<{ recorded: number; erased: number }> {
  const subredditName = context.subredditName;
  const startedAt = Date.now();
  const oldest = startedAt - current.cooldownDays * DAY_MS;
  const posts: IncomingPost[] = [];
  /** The posts in the list that may stay recorded. */
  const staying = new Set<string>();
  const removed: string[] = [];
  const deleted: string[] = [];
  // How far back the list was read. Nothing is concluded about older posts.
  let readBackTo = Infinity;
  // The listing is newest first, so reading stops at the first post that is past the cooldown.
  for await (const post of reddit.getNewPosts({ subredditName, limit: 1000, pageSize: 100 })) {
    const createdAt = post.createdAt.getTime();
    if (createdAt < oldest) {
      readBackTo = oldest;
      break;
    }
    readBackTo = Math.min(readBackTo, createdAt);
    const state = stateOf(post);
    if (state === 'up') {
      posts.push(fromReddit(post));
      staying.add(post.id);
    } else if (state === 'removed') {
      removed.push(post.id);
    } else {
      deleted.push(post.id);
    }
  }
  let erased = await forgetPosts(deleted, deps());
  const sorted = await forgetRemoved(removed, current, deps());
  erased += sorted.erased;
  for (const id of sorted.kept) staying.add(id);
  erased += await forgetUnlisted(staying, readBackTo, startedAt - LISTING_LAG_MS, current, deps());
  const recorded = await indexExistingPosts(posts, current, deps());
  return { recorded, erased };
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
      const { recorded, erased } = await rescan(await settingsOrDefaults());
      const what = path.endsWith('app-install') ? 'installed' : 'updated';
      log(`${what} in r/${context.subredditName}; recorded ${recorded} existing posts, erased ${erased} that are no longer up`);
      return {};
    }
    case '/internal/scheduler/daily-check': {
      // Not every delete and removal event arrives. This catches what was
      // missed, and reads again the posts that are up. It waits for the next
      // day rather than run on settings it had to guess.
      const { recorded, erased } = await rescan(await loadSettings());
      log(`daily check in r/${context.subredditName}; ${recorded} recent posts are up, erased ${erased} that are not`);
      return { status: 'ok' };
    }
    case '/internal/menu/rescan': {
      await readJson<MenuItemRequest>(req);
      const { recorded } = await rescan(await settingsOrDefaults());
      const response: UiResponse = {
        showToast: { text: `Repost Cooldown now knows ${recorded} recent posts.`, appearance: 'success' },
      };
      return response;
    }
    case '/internal/menu/erase': {
      await readJson<MenuItemRequest>(req);
      // Nothing is erased yet: the moderator is asked first, and the form's answer goes to the next endpoint.
      const response: UiResponse = {
        showForm: {
          name: ERASE_FORM,
          form: {
            title: 'Erase what Repost Cooldown has stored?',
            description:
              `This erases everything the app has stored for r/${context.subredditName}: the fingerprints of ` +
              'recent posts and its notes about them. It cannot be undone. The app stays switched on: it records ' +
              'new posts as they come in, and reads the existing ones again at its next daily check or when you ' +
              'pick "rescan recent posts". What an earlier version of the app stored, and this one cannot find, ' +
              'expires by itself.',
            fields: [{ type: 'boolean', name: 'confirm', label: 'Yes, erase it all', defaultValue: false }],
            acceptLabel: 'Erase',
            cancelLabel: 'Cancel',
          },
        },
      };
      return response;
    }
    case '/internal/form/erase': {
      const answer = await readJson<{ confirm?: unknown }>(req);
      let response: UiResponse = { showToast: 'Nothing was erased: the box was not ticked.' };
      if (answer.confirm === true) {
        const erased = await eraseEverything(deps());
        log(`a moderator erased everything stored for r/${context.subredditName}: ${erased} entries`);
        response = {
          showToast: { text: `Repost Cooldown erased everything it had stored (${erased} entries).`, appearance: 'success' },
        };
      }
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
