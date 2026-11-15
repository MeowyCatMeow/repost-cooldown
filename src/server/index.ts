/**
 * Devvit entry point. Reddit calls these endpoints (declared in devvit.json)
 * when a post is submitted or deleted, when the app is installed, and when a
 * moderator picks the rescan menu item. The rules live in ../core/cooldown.ts.
 */
import type { IncomingMessage } from 'node:http';
import { context, createServer, getServerPort, reddit, redis, settings } from '@devvit/web/server';
import type { MenuItemRequest, OnPostDeleteRequest, OnPostSubmitRequest, UiResponse } from '@devvit/web/shared';
import {
  handleNewPost,
  handlePostDeleted,
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
    await comment.distinguish(true);
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

async function loadSettings(): Promise<Settings> {
  try {
    return parseSettings(await settings.getAll<Record<string, unknown>>());
  } catch (error) {
    log(`could not read settings, using defaults: ${String(error)}`);
    return parseSettings(undefined);
  }
}

async function onPostSubmit(event: OnPostSubmitRequest): Promise<void> {
  const id = toPostId(event.post?.id);
  if (!event.post || !id) return;
  const post: IncomingPost = {
    id,
    title: event.post.title ?? '',
    url: event.post.url ?? '',
    authorName: event.author?.name ?? '',
    createdAt: toMillis(event.post.createdAt, Date.now()),
    crosspostParentId: event.post.crosspostParentId || undefined,
    subredditId: event.post.subredditId || event.subreddit?.id || context.subredditId,
    subredditName: event.subreddit?.name || context.subredditName,
  };
  const outcome = await handleNewPost(post, await loadSettings(), deps());
  if (outcome.action === 'removed' || outcome.action === 'exempt') {
    log(`${post.id} by u/${post.authorName}: ${outcome.action} (${outcome.reason} match with ${outcome.originalId})`);
  }
}

async function onPostDelete(event: OnPostDeleteRequest): Promise<void> {
  await handlePostDeleted(event.postId, { store: redis });
}

/** Reads the subreddit's newest posts (Reddit lists at most 1000) and records them. */
async function rescan(): Promise<number> {
  const subredditName = context.subredditName;
  const listed = await reddit.getNewPosts({ subredditName, limit: 1000, pageSize: 100 }).all();
  const posts: IncomingPost[] = listed
    .filter((post) => !post.removed && !post.spam && !post.removedByCategory)
    .map((post) => ({
      id: post.id,
      title: post.title,
      url: post.url,
      authorName: post.authorName,
      createdAt: post.createdAt.getTime(),
      crosspostParentId: post.crosspostParentId,
      subredditId: post.subredditId,
      subredditName,
    }));
  return indexExistingPosts(posts, await loadSettings(), deps());
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
    case '/internal/triggers/post-delete':
      await onPostDelete(await readJson<OnPostDeleteRequest>(req));
      return {};
    case '/internal/triggers/app-install': {
      const count = await rescan();
      log(`installed in r/${context.subredditName}; recorded ${count} existing posts`);
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
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
});

server.on('error', (error) => console.error('[repost-cooldown] server error:', error));
server.listen(getServerPort());
