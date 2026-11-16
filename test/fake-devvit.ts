/**
 * A stand-in for '@devvit/web/server', so that the real src/server/index.ts
 * can run in a test and be called over HTTP the way Reddit calls it. The
 * shapes follow the Devvit SDK: a missing Redis key reads as undefined,
 * getPostById throws for an unknown post, and a listing is read newest first.
 */
import { createServer as createHttpServer, type RequestListener, type Server } from 'node:http';

export type FakePost = {
  id: string;
  title: string;
  url: string;
  body: string;
  authorName: string;
  createdAt: Date;
  subredditId: string;
  permalink: string;
  removed: boolean;
  spam: boolean;
  removedByCategory?: string;
  crosspostParentId?: string;
};

export const state = {
  server: undefined as Server | undefined,
  redis: new Map<string, { value: string; expiresAt?: number }>(),
  /** Sorted sets: for each key, its members and their scores. */
  sorted: new Map<string, Map<string, number>>(),
  posts: new Map<string, FakePost>(),
  moderators: new Set<string>(),
  settings: {} as Record<string, unknown>,
  /** Makes the next reads of the settings fail, as in an outage. */
  settingsFail: false,
  /** Makes pinning a comment fail after the comment was made. */
  distinguishFail: false,
  removed: [] as string[],
  comments: [] as Array<{ id: string; text: string; pinned: boolean }>,
  deletedComments: [] as string[],
  notes: [] as string[],
  /** How many pages of the "new" listing were read. */
  listingPages: 0,
};

/** Puts the fake Reddit and the fake storage back to empty. */
export function reset(): void {
  state.redis.clear();
  state.sorted.clear();
  state.posts.clear();
  state.moderators.clear();
  state.settings = {};
  state.settingsFail = false;
  state.distinguishFail = false;
  state.removed.length = 0;
  state.comments.length = 0;
  state.deletedComments.length = 0;
  state.notes.length = 0;
  state.listingPages = 0;
}

export function addPost(fields: Partial<FakePost> & { id: string }): FakePost {
  const short = fields.id.slice(3);
  const post: FakePost = {
    title: `Title of ${fields.id}`,
    url: `https://www.reddit.com/r/home/comments/${short}/slug/`,
    body: '',
    authorName: 'alice',
    createdAt: new Date(),
    subredditId: 't5_home',
    permalink: `/r/home/comments/${short}/slug/`,
    removed: false,
    spam: false,
    ...fields,
  };
  state.posts.set(post.id, post);
  return post;
}

export const context = { subredditName: 'home', subredditId: 't5_home', appSlug: 'repost-cooldown' };

export function createServer(listener: RequestListener): Server {
  state.server = createHttpServer(listener);
  return state.server;
}

/** Port 0 asks for any free port; the test reads the real one from the server. */
export function getServerPort(): number {
  return 0;
}

function read(key: string): string | undefined {
  const item = state.redis.get(key);
  if (!item) return undefined;
  if (item.expiresAt !== undefined && item.expiresAt <= Date.now()) {
    state.redis.delete(key);
    return undefined;
  }
  return item.value;
}

export const redis = {
  async get(key: string): Promise<string | undefined> {
    return read(key);
  },
  async set(key: string, value: string, options?: { nx?: boolean; expiration?: Date }): Promise<string> {
    if (options?.nx && read(key) !== undefined) return '';
    state.redis.set(key, { value, expiresAt: options?.expiration?.getTime() });
    return 'OK';
  },
  async del(...keys: string[]): Promise<void> {
    for (const key of keys) state.redis.delete(key);
  },
  async zAdd(key: string, ...members: Array<{ member: string; score: number }>): Promise<number> {
    const set = state.sorted.get(key) ?? new Map<string, number>();
    state.sorted.set(key, set);
    for (const { member, score } of members) set.set(member, score);
    return members.length;
  },
  async zRange(
    key: string,
    start: number | string,
    stop: number | string,
    options?: { by: 'score' | 'lex' | 'rank' }
  ): Promise<Array<{ member: string; score: number }>> {
    if (options?.by !== 'score') throw new Error('this stand-in only ranges by score');
    return [...(state.sorted.get(key) ?? [])]
      .filter(([, score]) => score >= Number(start) && score <= Number(stop))
      .sort((a, b) => a[1] - b[1])
      .map(([member, score]) => ({ member, score }));
  },
  async zRem(key: string, members: string[]): Promise<number> {
    const set = state.sorted.get(key);
    return members.filter((member) => set?.delete(member)).length;
  },
  async zRemRangeByScore(key: string, min: number, max: number): Promise<number> {
    const set = state.sorted.get(key);
    const members = [...(set ?? [])].filter(([, score]) => score >= min && score <= max).map(([member]) => member);
    for (const member of members) set!.delete(member);
    return members.length;
  },
};

export const reddit = {
  async getPostById(id: string): Promise<FakePost> {
    const post = state.posts.get(id);
    if (!post) throw new Error(`no post ${id}`);
    return post;
  },
  getModerators(options: { subredditName: string; username?: string }) {
    return {
      async all(): Promise<Array<{ username: string }>> {
        return options.username && state.moderators.has(options.username) ? [{ username: options.username }] : [];
      },
    };
  },
  async remove(id: string, _isSpam: boolean): Promise<void> {
    state.removed.push(id);
    const post = state.posts.get(id);
    if (post) {
      post.removed = true;
      post.removedByCategory = 'moderator';
    }
  },
  async submitComment(options: { id: string; text: string }) {
    const comment = { id: options.id, text: options.text, pinned: false };
    state.comments.push(comment);
    return {
      id: `t1_c${state.comments.length}`,
      async distinguish(makeSticky = false): Promise<void> {
        if (state.distinguishFail) throw new Error('could not distinguish');
        comment.pinned = makeSticky;
      },
    };
  },
  async getCommentById(commentId: string) {
    return {
      async delete(): Promise<void> {
        state.deletedComments.push(commentId);
      },
    };
  },
  async addRemovalNote(options: { itemIds: string[]; reasonId: string; modNote: string }): Promise<void> {
    state.notes.push(options.modNote);
  },
  getNewPosts(options: { subredditName: string; limit?: number; pageSize?: number }) {
    const newestFirst = [...state.posts.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, options.limit ?? Infinity);
    const pageSize = options.pageSize ?? 100;
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<FakePost> {
        for (const [index, post] of newestFirst.entries()) {
          if (index % pageSize === 0) state.listingPages++;
          yield post;
        }
      },
    };
  },
};

export const settings = {
  async getAll<T>(): Promise<T> {
    if (state.settingsFail) throw new Error('could not get the installation settings');
    return { ...state.settings } as T;
  },
};
