import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  DEFAULT_SETTINGS,
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
  type Deps,
  type IncomingPost,
  type PostInfo,
  type Settings,
  type Store,
} from '../src/core/cooldown.ts';

const DAY = 24 * 60 * 60 * 1000;
const SUB = 't5_home';
const START = Date.UTC(2026, 0, 1);

/** Every stand-in subreddit a test makes, so that each can be checked when the test is over. */
const worlds: World[] = [];
// Whatever a test did, every key the app wrote must be on its list of keys:
// that list is what lets a moderator erase everything.
afterEach(() => {
  for (const world of worlds.splice(0)) assert.deepEqual(world.unlisted(), []);
});

/** A stand-in for one subreddit: a clock, a key-value store, and its posts. */
class World {
  time = START;
  data = new Map<string, { value: string; expiresAt?: number }>();
  /** Sorted sets: for each key, its members and their scores. */
  sorted = new Map<string, Map<string, number>>();
  posts = new Map<string, PostInfo>();
  /** What each post says, as Reddit would return it. */
  contents = new Map<string, IncomingPost>();
  moderators = new Set<string>();
  removed: string[] = [];
  comments: Array<{ id: string; text: string }> = [];
  deletedComments: string[] = [];
  notes: string[] = [];
  unreadable = new Set<string>();
  nextId = 1;

  store: Store = {
    get: async (key) => this.read(key),
    set: async (key, value, options) => {
      // Like Redis, "set if absent" checks and writes in one step.
      if (options?.nx && this.read(key) !== undefined) return '';
      this.data.set(key, { value, expiresAt: options?.expiration?.getTime() });
      return 'OK';
    },
    del: async (...keys) => {
      for (const key of keys) {
        this.data.delete(key);
        this.sorted.delete(key);
      }
    },
    exists: async (...keys) =>
      keys.filter((key) => this.read(key) !== undefined || (this.sorted.get(key)?.size ?? 0) > 0).length,
    zAdd: async (key, ...members) => {
      const set = this.sorted.get(key) ?? new Map<string, number>();
      this.sorted.set(key, set);
      for (const { member, score } of members) set.set(member, score);
    },
    zRange: async (key, start, stop, options) => {
      const ordered = [...(this.sorted.get(key) ?? [])]
        .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
        .map(([member, score]) => ({ member, score }));
      // By rank, both ends count, as in Redis.
      if (options.by === 'rank') return ordered.slice(start, stop + 1);
      return ordered.filter(({ score }) => score >= start && score <= stop);
    },
    zRem: async (key, members) => {
      for (const member of members) this.sorted.get(key)?.delete(member);
    },
    zRemRangeByScore: async (key, min, max) => {
      const set = this.sorted.get(key);
      for (const [member, score] of [...(set ?? [])]) if (score >= min && score <= max) set!.delete(member);
    },
  };

  /** The posts the app lists as recorded, oldest first. */
  listed(): string[] {
    return [...(this.sorted.get('recorded') ?? [])].sort((a, b) => a[1] - b[1]).map(([member]) => member);
  }

  /** The keys that exist without being on the app's list of what it has written. There should never be any. */
  unlisted(): string[] {
    return [...this.data.keys()].filter((key) => this.read(key) !== undefined && !this.sorted.get('keys')?.has(key));
  }

  constructor() {
    worlds.push(this);
  }

  read(key: string): string | undefined {
    const item = this.data.get(key);
    if (!item) return undefined;
    if (item.expiresAt !== undefined && item.expiresAt <= this.time) {
      this.data.delete(key);
      return undefined;
    }
    return item.value;
  }

  /** The stored keys that say anything about a post: keys named after it, and values that name it. */
  about(id: string): string[] {
    return [...this.data.keys()]
      .filter((key) => {
        const value = this.read(key);
        return value !== undefined && (key.endsWith(`:${id}`) || value.includes(`"${id}"`));
      })
      .sort();
  }

  deps: Deps = {
    store: this.store,
    now: () => this.time,
    exemptAuthors: ['repost-cooldown'],
    reddit: {
      getPostInfo: async (id) => {
        const info = this.posts.get(id);
        if (!info || this.unreadable.has(id)) throw new Error(`cannot read ${id}`);
        return info;
      },
      getPost: async (id) => {
        const info = this.posts.get(id);
        if (!info || this.unreadable.has(id)) throw new Error(`cannot read ${id}`);
        return { state: info.state, post: this.contents.get(id)! };
      },
      isModerator: async (username) => this.moderators.has(username),
      remove: async (id) => {
        this.removed.push(id);
        const info = this.posts.get(id);
        if (info) info.state = 'removed';
      },
      comment: async (id, text) => {
        this.comments.push({ id, text });
        return `t1_c${this.comments.length}`;
      },
      deleteComment: async (commentId) => {
        this.deletedComments.push(commentId);
      },
      addRemovalNote: async (_id, note) => {
        this.notes.push(note);
      },
    },
  };

  advance(days: number): void {
    this.time += days * DAY;
  }

  /** Creates a post in a subreddit without telling the app about it. */
  make(fields: Partial<IncomingPost> = {}): IncomingPost {
    const id = fields.id ?? `t3_p${this.nextId++}`;
    const subredditId = fields.subredditId ?? SUB;
    const post: IncomingPost = {
      id,
      title: `A reasonably unique title number ${id}`,
      url: `https://www.reddit.com/r/home/comments/${id.slice(3)}/slug/`,
      authorName: 'alice',
      createdAt: this.time,
      subredditId,
      subredditName: 'home',
      ...fields,
    };
    this.posts.set(id, { id, subredditId, createdAt: post.createdAt, state: 'up', permalink: `/r/home/comments/${id.slice(3)}/slug/` });
    this.contents.set(id, post);
    return post;
  }

  /**
   * Makes a delete event for `id` get handled in the middle of whatever writes
   * next: right after the first write to a key that starts with `prefix`.
   */
  deleteDuring(id: string, prefix: string): void {
    const set = this.store.set;
    let done = false;
    this.store.set = async (key, value, options) => {
      const result = await set(key, value, options);
      if (!done && key.startsWith(prefix)) {
        done = true;
        await forgetPost(id, this.deps);
      }
      return result;
    };
  }

  /** Creates a post and runs it through the app, as the submit trigger would. */
  async submit(fields: Partial<IncomingPost> = {}, settings: Settings = DEFAULT_SETTINGS) {
    const post = this.make(fields);
    const outcome = await handleNewPost(post, settings, this.deps);
    return { post, outcome };
  }
}

test('a crosspost of a recent post from the same subreddit is removed', async () => {
  const w = new World();
  const original = await w.submit({ title: 'New model released today', url: 'https://i.redd.it/pic1.jpg' });
  assert.equal(original.outcome.action, 'indexed');

  w.advance(10);
  const cross = await w.submit({
    title: 'Look at this (crosspost)',
    url: 'https://i.redd.it/pic1.jpg',
    crosspostParentId: original.post.id,
    authorName: 'bob',
  });
  assert.deepEqual(cross.outcome, { action: 'removed', reason: 'crosspost', originalId: original.post.id });
  assert.deepEqual(w.removed, [cross.post.id]);
  assert.equal(w.comments.length, 1);
  assert.match(w.comments[0]!.text, /u\/bob/);
  assert.match(w.comments[0]!.text, /crosspost/);
  assert.match(w.comments[0]!.text, /10 days ago/);
  assert.match(w.comments[0]!.text, /30 days/);
  assert.ok(w.comments[0]!.text.includes(`https://www.reddit.com/r/home/comments/${original.post.id.slice(3)}/slug/`));
  assert.ok(w.notes[0]!.length <= 100);
});

test('a crosspost is allowed once the original is past the cooldown', async () => {
  const w = new World();
  const original = await w.submit({ title: 'New model released today' });
  w.advance(31);
  const cross = await w.submit({ title: 'New model released today', crosspostParentId: original.post.id });
  assert.equal(cross.outcome.action, 'indexed');
  assert.deepEqual(w.removed, []);

  // The allowed crosspost restarts the clock for that content.
  w.advance(5);
  const again = await w.submit({ title: 'New model released today', crosspostParentId: original.post.id });
  assert.deepEqual(again.outcome, { action: 'removed', reason: 'title', originalId: cross.post.id });
});

test('a crosspost of a same-sub post from before the app was installed is caught through Reddit', async () => {
  const w = new World();
  const old = w.make();
  w.advance(3);
  const cross = await w.submit({ title: 'different words entirely here', crosspostParentId: old.id });
  assert.deepEqual(cross.outcome, { action: 'removed', reason: 'crosspost', originalId: old.id });
});

test('a crosspost from another subreddit is not a same-sub crosspost', async () => {
  const w = new World();
  const elsewhere = w.make({ subredditId: 't5_other', url: 'https://example.com/story' });
  w.advance(1);
  const first = await w.submit({ title: 'Story from elsewhere', url: 'https://example.com/story', crosspostParentId: elsewhere.id });
  assert.equal(first.outcome.action, 'indexed');

  // ...but crossposting the same outside post a second time is a repost.
  w.advance(1);
  const second = await w.submit({ title: 'Seen this one yet', url: 'https://example.com/story', crosspostParentId: elsewhere.id });
  assert.deepEqual(second.outcome, { action: 'removed', reason: 'link', originalId: first.post.id });
});

test('a plain link to a recent post in the same subreddit counts as a crosspost', async () => {
  const w = new World();
  const original = await w.submit();
  w.advance(2);
  const link = await w.submit({
    title: 'Everyone should read this thread',
    url: `https://old.reddit.com/r/home/comments/${original.post.id.slice(3)}/slug/`,
  });
  assert.deepEqual(link.outcome, { action: 'removed', reason: 'crosspost', originalId: original.post.id });
});

test('the same link is removed inside the cooldown and allowed after it', async () => {
  const w = new World();
  const first = await w.submit({ title: 'First take on the paper', url: 'https://www.example.com/paper?utm_source=reddit' });
  w.advance(29);
  const second = await w.submit({ title: 'Second take on the paper', url: 'http://example.com/paper/' });
  assert.deepEqual(second.outcome, { action: 'removed', reason: 'link', originalId: first.post.id });

  w.advance(2); // day 31
  const third = await w.submit({ title: 'Third take on the paper', url: 'https://example.com/paper' });
  assert.equal(third.outcome.action, 'indexed');
});

test('the same title is removed, ignoring case and punctuation', async () => {
  const w = new World();
  const first = await w.submit({ title: 'Claude 5 is out: first impressions?' });
  w.advance(1);
  const second = await w.submit({ title: 'claude 5 is out - First Impressions' });
  assert.deepEqual(second.outcome, { action: 'removed', reason: 'title', originalId: first.post.id });
  const third = await w.submit({ title: 'Claude 5 is out: second impressions' });
  assert.equal(third.outcome.action, 'indexed');
});

test('very short titles are not compared', async () => {
  const w = new World();
  await w.submit({ title: 'Help' });
  const second = await w.submit({ title: 'Help!' });
  assert.equal(second.outcome.action, 'indexed');

  const strict = { ...DEFAULT_SETTINGS, minTitleLength: 0 };
  await w.submit({ title: 'Question' }, strict);
  const fourth = await w.submit({ title: 'question?' }, strict);
  assert.equal(fourth.outcome.action, 'removed');
});

test('text posts with different titles never match on link', async () => {
  const w = new World();
  const a = await w.submit({ title: 'My thoughts on agents this year' });
  const b = await w.submit({ title: 'My thoughts on evals this year' });
  assert.equal(a.outcome.action, 'indexed');
  assert.equal(b.outcome.action, 'indexed');
});

const LONG_TEXT =
  'To the OP! Please, I would like to know if you have any kinds of physical feelings toward the AIs you like.';

test('the same text under a different title is removed', async () => {
  const w = new World();
  const first = await w.submit({ title: 'To the OP! please! I would like to know', body: LONG_TEXT, isSelf: true });
  assert.deepEqual(first.outcome, { action: 'indexed', compared: ['text', 'title'] });
  w.advance(1);
  const second = await w.submit({
    title: 'but I love the work he is helping me create',
    body: `  ${LONG_TEXT.toUpperCase()}\n\n`,
    isSelf: true,
    authorName: 'bob',
  });
  assert.deepEqual(second.outcome, { action: 'removed', reason: 'text', originalId: first.post.id });
  assert.match(w.comments[0]!.text, /same text/);

  w.advance(31);
  const third = await w.submit({ title: 'A third title for the same words', body: LONG_TEXT, isSelf: true });
  assert.equal(third.outcome.action, 'indexed');
});

test('different text under different titles is kept', async () => {
  const w = new World();
  await w.submit({ title: 'To the OP! please! I would like to know', body: LONG_TEXT, isSelf: true });
  const second = await w.submit({ title: 'A different question entirely', body: `${LONG_TEXT} And one more thing.`, isSelf: true });
  assert.equal(second.outcome.action, 'indexed');
});

test('very short text is not compared, and the text check can be switched off', async () => {
  const w = new World();
  await w.submit({ title: 'First title for a short body', body: 'Title says it all.', isSelf: true });
  const second = await w.submit({ title: 'Second title for a short body', body: 'title says it all', isSelf: true });
  assert.equal(second.outcome.action, 'indexed');

  const off = { ...DEFAULT_SETTINGS, checkText: false };
  await w.submit({ title: 'Third title, long body this time', body: LONG_TEXT, isSelf: true }, off);
  const fourth = await w.submit({ title: 'Fourth title, long body this time', body: LONG_TEXT, isSelf: true }, off);
  assert.equal(fourth.outcome.action, 'indexed');
});

test('a text post is never compared by link, whatever address Reddit reports for it', async () => {
  const w = new World();
  const shared = 'https://www.reddit.com/r/home/submit';
  await w.submit({ title: 'First text post with an odd address', url: shared, isSelf: true });
  const second = await w.submit({ title: 'Second text post with an odd address', url: shared, isSelf: true });
  assert.deepEqual(second.outcome, { action: 'indexed', compared: ['title'] });
});

test('existing posts are recorded by their text too', async () => {
  const w = new World();
  const old = w.make({ title: 'An earlier title for these words', body: LONG_TEXT });
  w.advance(2);
  await indexExistingPosts([old], DEFAULT_SETTINGS, w.deps);
  const repeat = await w.submit({ title: 'A later title for these words', body: LONG_TEXT, isSelf: true });
  assert.deepEqual(repeat.outcome, { action: 'removed', reason: 'text', originalId: old.id });
});

test('the same title over different text is kept', async () => {
  const w = new World();
  const title = 'Is Claude down for anyone else right now';
  await w.submit({ title, body: 'I keep getting errors on every message since this morning.', isSelf: true });
  w.advance(3);
  const second = await w.submit({ title, body: 'Started about ten minutes ago for me, on the mobile app only.', isSelf: true });
  assert.deepEqual(second.outcome, { action: 'indexed', compared: ['text', 'title'] });
  assert.deepEqual(w.removed, []);
});

test('the same title over the same short text is removed', async () => {
  const w = new World();
  const title = 'Is Claude down for anyone else right now';
  const first = await w.submit({ title, body: 'See title.', isSelf: true });
  const second = await w.submit({ title: title.toUpperCase(), body: 'see title', isSelf: true });
  assert.deepEqual(second.outcome, { action: 'removed', reason: 'title', originalId: first.post.id });
});

test('a title is not shared between a post with text and a post without', async () => {
  const w = new World();
  const title = 'Is Claude down for anyone else right now';
  await w.submit({ title, body: 'I keep getting errors on every message since this morning.', isSelf: true });
  const image = await w.submit({ title, url: 'https://i.redd.it/screenshot1.png' });
  assert.equal(image.outcome.action, 'indexed');

  // Two textless posts with one title are still a repost.
  const again = await w.submit({ title, url: 'https://i.redd.it/screenshot2.png' });
  assert.deepEqual(again.outcome, { action: 'removed', reason: 'title', originalId: image.post.id });
});

const VIDEO = 'https://www.youtube.com/watch?v=45RTkHgR3Gc';

test('a front page link is never a repost', async () => {
  const w = new World();
  const first = await w.submit({ title: 'My favourite site for tutorials', url: 'https://www.youtube.com/' });
  assert.deepEqual(first.outcome, { action: 'indexed', compared: ['title'] });
  const second = await w.submit({ title: 'Where I learn most things now', url: 'http://youtube.com?utm_source=share' });
  assert.equal(second.outcome.action, 'indexed');

  // The same video is still a repost.
  await w.submit({ title: 'Watch this one before the weekend', url: VIDEO });
  const repeat = await w.submit({ title: 'Great talk, worth the full hour', url: 'https://youtu.be/45RTkHgR3Gc?t=30' });
  assert.equal(repeat.outcome.action, 'removed');
});

test('a link inside post text matches an earlier link post', async () => {
  const w = new World();
  const first = await w.submit({ title: 'Watch this one before the weekend', url: VIDEO });
  w.advance(2);
  const second = await w.submit({
    title: 'Has anyone else seen this talk',
    body: 'I found this and thought of you all: [the talk](https://youtu.be/45RTkHgR3Gc). Thoughts?',
    isSelf: true,
  });
  assert.deepEqual(second.outcome, { action: 'removed', reason: 'link', originalId: first.post.id });
  assert.match(w.comments[0]!.text, /shares a link/);
});

test('two text posts that mention the same link match, and a later link post matches them', async () => {
  const w = new World();
  const first = await w.submit({ title: 'First write-up about the product', body: `Details here: ${VIDEO}.`, isSelf: true });
  const second = await w.submit({ title: 'Another angle on the product', body: `Different words, same thing (${VIDEO})`, isSelf: true });
  assert.deepEqual(second.outcome, { action: 'removed', reason: 'link', originalId: first.post.id });
  const third = await w.submit({ title: 'Just the video on its own', url: VIDEO });
  assert.deepEqual(third.outcome, { action: 'removed', reason: 'link', originalId: first.post.id });
});

test('text links to Reddit and to front pages are not compared', async () => {
  const w = new World();
  const body = 'Following up on https://www.reddit.com/r/home/comments/abc123/earlier_thread/ and see https://openai.com/ too.';
  await w.submit({ title: 'A follow-up to the earlier thread', body, isSelf: true });
  const second = await w.submit({ title: 'My own follow-up to that thread', body: `${body} Plus my own take on it all.`, isSelf: true });
  assert.equal(second.outcome.action, 'indexed');
});

test('a post with many links is a roundup and its links are not compared', async () => {
  const w = new World();
  await w.submit({ title: 'Watch this one before the weekend', url: VIDEO });
  const six = [1, 2, 3, 4, 5].map((n) => `https://example.com/story-${n}`).concat(VIDEO).join('\n\n');
  const roundup = await w.submit({ title: 'This week in links, issue twelve', body: six, isSelf: true });
  assert.equal(roundup.outcome.action, 'indexed');

  const off = { ...DEFAULT_SETTINGS, maxTextLinks: 0 };
  const quiet = await w.submit({ title: 'Mentioning the talk in passing', body: `See ${VIDEO}`, isSelf: true }, off);
  assert.equal(quiet.outcome.action, 'indexed');
});

test('each check can be switched off', async () => {
  const w = new World();
  const off = { ...DEFAULT_SETTINGS, checkCrossposts: false, checkLinks: false, checkTitles: false };
  const first = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' }, off);
  const second = await w.submit(
    { title: 'The very same title twice', url: 'https://example.com/x', crosspostParentId: first.post.id },
    off
  );
  assert.equal(second.outcome.action, 'indexed');
});

test('a shorter cooldown setting applies to posts already recorded', async () => {
  const w = new World();
  await w.submit({ title: 'The very same title twice' });
  w.advance(8);
  const second = await w.submit({ title: 'The very same title twice' }, { ...DEFAULT_SETTINGS, cooldownDays: 7 });
  assert.equal(second.outcome.action, 'indexed');
});

test('moderators, AutoModerator and the app itself are not removed', async () => {
  const w = new World();
  w.moderators.add('modmary');
  await w.submit({ title: 'Weekly discussion thread' });
  for (const authorName of ['modmary', 'AutoModerator', 'repost-cooldown']) {
    const repeat = await w.submit({ title: 'Weekly discussion thread', authorName });
    assert.equal(repeat.outcome.action, 'exempt', authorName);
  }
  assert.deepEqual(w.removed, []);

  const strict = { ...DEFAULT_SETTINGS, exemptModerators: false };
  const byMod = await w.submit({ title: 'Weekly discussion thread', authorName: 'modmary' }, strict);
  assert.equal(byMod.outcome.action, 'removed');
});

test('a removed original does not block a new post, and is erased once that is noticed', async () => {
  const w = new World();
  const first = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' });
  w.posts.get(first.post.id)!.state = 'removed'; // removed, and the app was never told
  w.advance(1);
  const second = await w.submit({ title: 'The very same title twice', url: 'https://example.com/y' });
  assert.equal(second.outcome.action, 'indexed');
  // All of the first post went, not only the title that was repeated.
  assert.deepEqual(w.about(first.post.id), [`gone:${first.post.id}`, `seen:${first.post.id}`]);

  // The replacement is now the original.
  w.advance(1);
  const third = await w.submit({ title: 'The very same title twice', url: 'https://example.com/z' });
  assert.deepEqual(third.outcome, { action: 'removed', reason: 'title', originalId: second.post.id });
  const fourth = await w.submit({ title: 'Other words for the first link', url: 'https://example.com/x' });
  assert.equal(fourth.outcome.action, 'indexed');
});

test('a post the app removed is not treated as an original later', async () => {
  const w = new World();
  const first = await w.submit({ title: 'The very same title twice' });
  const second = await w.submit({ title: 'The very same title twice' });
  assert.equal(second.outcome.action, 'removed');
  w.advance(1);
  const third = await w.submit({ title: 'The very same title twice' });
  assert.deepEqual(third.outcome, { action: 'removed', reason: 'title', originalId: first.post.id });
});

test('deleting the original frees its link and title', async () => {
  const w = new World();
  const first = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' });
  assert.equal(await forgetPost(first.post.id, w.deps), true);
  const second = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' });
  assert.equal(second.outcome.action, 'indexed');

  // Deleting a post that owns nothing must not free someone else's keys.
  const third = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' });
  assert.equal(third.outcome.action, 'removed');
  assert.equal(await forgetPost(third.post.id, w.deps), false);
  const fourth = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' });
  assert.equal(fourth.outcome.action, 'removed');
});

test('a deleted or removed post is erased completely', async () => {
  const w = new World();
  const fields = { title: 'First write-up about the product', body: `${LONG_TEXT} ${VIDEO}`, isSelf: true };
  const first = await w.submit(fields);
  assert.deepEqual(first.outcome, { action: 'indexed', compared: ['link', 'text', 'title'] });
  assert.equal(w.about(first.post.id).filter((key) => key.startsWith('fp:')).length, 3);

  assert.equal(await forgetPost(first.post.id, w.deps), true);
  // What is left says only that there was such a post: no fingerprint and no record.
  assert.deepEqual(w.about(first.post.id), [`gone:${first.post.id}`, `seen:${first.post.id}`]);
  assert.deepEqual([...w.data.keys()].filter((key) => key.startsWith('fp:') || key.startsWith('post:')), []);
  // Erasing it a second time, as when Reddit reports a removal twice, changes nothing.
  assert.equal(await forgetPost(first.post.id, w.deps), false);

  // The same post can be made again, and is then the original.
  const second = await w.submit(fields);
  assert.equal(second.outcome.action, 'indexed');
  const third = await w.submit(fields);
  assert.deepEqual(third.outcome, { action: 'removed', reason: 'link', originalId: second.post.id });
});

test('erasing a post leaves alone a fingerprint that a newer post has taken over', async () => {
  const w = new World();
  const week = { ...DEFAULT_SETTINGS, cooldownDays: 7 };
  const first = await w.submit({ title: 'The very same title twice' }, week);
  w.advance(8);
  const second = await w.submit({ title: 'The very same title twice' }, week);
  assert.equal(second.outcome.action, 'indexed');
  w.time += 1000;
  await forgetPost(first.post.id, w.deps);
  const third = await w.submit({ title: 'The very same title twice' }, week);
  assert.deepEqual(third.outcome, { action: 'removed', reason: 'title', originalId: second.post.id });
});

test('a submit event that arrives after the post is gone records nothing', async () => {
  const w = new World();
  const late = w.make({ title: 'The very same title twice', url: 'https://example.com/x' });
  // Reddit does not promise the order of events: the delete can be handled first.
  assert.equal(await forgetPost(late.id, w.deps), false);
  assert.deepEqual(await handleNewPost(late, DEFAULT_SETTINGS, w.deps), { action: 'gone' });
  assert.deepEqual(w.about(late.id), [`gone:${late.id}`, `seen:${late.id}`]);
  assert.equal([...w.data.keys()].some((key) => key.startsWith('fp:')), false);
  // Sending it again changes nothing.
  assert.equal((await handleNewPost(late, DEFAULT_SETTINGS, w.deps)).action, 'duplicate-event');

  // So it is not an original: the same thing posted afterwards is kept.
  const next = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' });
  assert.equal(next.outcome.action, 'indexed');
});

test('a repost that a filter is holding back is still removed, but a moderator who posts one is not recorded', async () => {
  const w = new World();
  const original = await w.submit({ title: 'The very same title twice' });
  // The filter's removal is handled before the submit event.
  const held = w.make({ title: 'The very same title twice', authorName: 'bob' });
  await forgetPost(held.id, w.deps);
  assert.deepEqual(await handleNewPost(held, DEFAULT_SETTINGS, w.deps), { action: 'removed', reason: 'title', originalId: original.post.id });
  assert.deepEqual(w.removed, [held.id]);
  assert.match(w.comments[0]!.text, /u\/bob/);

  w.moderators.add('modmary');
  const byMod = w.make({ title: 'The very same title twice', url: 'https://example.com/mod', authorName: 'modmary' });
  await forgetPost(byMod.id, w.deps);
  assert.equal((await handleNewPost(byMod, DEFAULT_SETTINGS, w.deps)).action, 'exempt');
  assert.deepEqual(w.about(byMod.id), [`gone:${byMod.id}`, `seen:${byMod.id}`]);
});

test('a post deleted while it is being recorded is not kept', async () => {
  // The delete is handled after the record is written, after the first fingerprint, and after the last.
  for (const moment of ['post:', 'fp:link:', 'fp:title-text:']) {
    const w = new World();
    const post = w.make({ title: 'First write-up about the product', body: `${LONG_TEXT} ${VIDEO}`, isSelf: true });
    w.deleteDuring(post.id, moment);
    assert.deepEqual(await handleNewPost(post, DEFAULT_SETTINGS, w.deps), { action: 'gone' }, moment);
    assert.deepEqual(w.about(post.id), [`gone:${post.id}`, `seen:${post.id}`], moment);
  }
});

test('a post deleted while an edit or a rescan is recording it is not kept', async () => {
  const edited = new World();
  const first = await edited.submit({ title: 'First write-up about the product', body: `Details here: ${VIDEO}`, isSelf: true });
  edited.deleteDuring(first.post.id, 'fp:link:');
  const change = { ...first.post, body: 'Details here: https://example.com/new-page' };
  assert.equal(await handlePostEdited(change, settings, edited.deps), false);
  assert.deepEqual(edited.about(first.post.id), [`gone:${first.post.id}`, `seen:${first.post.id}`]);

  const scanned = new World();
  const stays = scanned.make({ title: 'A post that stays where it is', url: 'https://example.com/stays' });
  const goes = scanned.make({ title: 'A post that is deleted meanwhile', url: 'https://example.com/goes' });
  scanned.deleteDuring(goes.id, `post:${goes.id}`);
  assert.equal(await indexExistingPosts([stays, goes], DEFAULT_SETTINGS, scanned.deps), 1);
  assert.deepEqual(scanned.about(goes.id), [`gone:${goes.id}`]);
  assert.equal(scanned.about(stays.id).length, 3);

  // A post that was gone before the rescan began is not recorded by it either.
  assert.equal(await indexExistingPosts([stays, goes], DEFAULT_SETTINGS, scanned.deps), 1);
  assert.deepEqual(scanned.about(goes.id), [`gone:${goes.id}`]);
});

test('when the original cannot be checked, the new post is left alone', async () => {
  const w = new World();
  const first = await w.submit({ title: 'The very same title twice' });
  w.unreadable.add(first.post.id);
  const second = await w.submit({ title: 'The very same title twice' });
  assert.equal(second.outcome.action, 'indexed');
  assert.deepEqual(w.removed, []);
});

test('the same event delivered twice is handled once', async () => {
  const w = new World();
  const first = await w.submit({ title: 'The very same title twice' });
  const again = await handleNewPost(first.post, DEFAULT_SETTINGS, w.deps);
  assert.equal(again.action, 'duplicate-event');
  assert.deepEqual(w.removed, []);
});

test('the same event delivered twice at the same moment is handled once', async () => {
  const w = new World();
  await w.submit({ title: 'The very same title twice' });
  const repeat = w.make({ title: 'The very same title twice' });
  const outcomes = await Promise.all([
    handleNewPost(repeat, DEFAULT_SETTINGS, w.deps),
    handleNewPost(repeat, DEFAULT_SETTINGS, w.deps),
  ]);
  assert.deepEqual(outcomes.map((outcome) => outcome.action).sort(), ['duplicate-event', 'removed']);
  assert.deepEqual(w.removed, [repeat.id]);
  assert.equal(w.comments.length, 1);
});

test('titles that differ only in vowel signs are different titles', async () => {
  const w = new World();
  await w.submit({ title: 'आज राम ने खाना खाया और सो गया' });
  const other = await w.submit({ title: 'आज राम ने खाने खाये और सो गये' });
  assert.equal(other.outcome.action, 'indexed');
  const same = await w.submit({ title: 'आज राम ने खाना खाया और सो गया!' });
  assert.equal(same.outcome.action, 'removed');
});

test('unknown placeholders in the removal comment are left as written', async () => {
  const w = new World();
  const custom = { ...DEFAULT_SETTINGS, removalMessage: 'Removed, u/{author}. {constructor} {toString} {unknown}' };
  await w.submit({ title: 'The very same title twice' }, custom);
  await w.submit({ title: 'The very same title twice', authorName: 'bob' }, custom);
  assert.equal(w.comments[0]!.text, 'Removed, u/bob. {constructor} {toString} {unknown}');
});

test('a post stays up when its author cannot be checked, and the log names no one', async () => {
  const w = new World();
  const lines: string[] = [];
  w.deps.log = (line) => lines.push(line);
  w.deps.reddit.isModerator = async () => {
    throw new Error('reddit is down');
  };
  await w.submit({ title: 'The very same title twice' });
  const repeat = await w.submit({ title: 'The very same title twice', authorName: 'someuser' });
  assert.equal(repeat.outcome.action, 'exempt');
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes(repeat.post.id));
  assert.ok(!lines[0]!.includes('someuser'));

  // The same goes for a post that arrives without its author's name.
  const nameless = await w.submit({ title: 'The very same title twice', authorName: '' });
  assert.equal(nameless.outcome.action, 'exempt');
  assert.deepEqual(w.removed, []);
  assert.equal(w.comments.length, 0);
});

test('with the crosspost check off, a crosspost inside the subreddit is kept', async () => {
  const w = new World();
  const off = { ...DEFAULT_SETTINGS, checkCrossposts: false };
  const picture = 'https://i.redd.it/pic1.jpg';
  const original = await w.submit({ title: 'New model released today', url: picture }, off);
  w.advance(1);
  // A crosspost carries the link and the title of the post it shows.
  const cross = await w.submit({ title: 'New model released today', url: picture, crosspostParentId: original.post.id }, off);
  assert.equal(cross.outcome.action, 'indexed');
  // The same picture posted again, not as a crosspost, is still a repost.
  const repost = await w.submit({ title: 'Different words for the same thing', url: picture }, off);
  assert.deepEqual(repost.outcome, { action: 'removed', reason: 'link', originalId: original.post.id });
});

test('a text post that quotes a picture posted earlier is kept', async () => {
  const w = new World();
  const picture = 'https://i.redd.it/chart1.png';
  await w.submit({ title: 'A chart of this year so far', url: picture });
  const talk = await w.submit({
    title: 'About that chart from earlier today',
    body: `I think ${picture} is misleading because of where its axis starts.`,
    isSelf: true,
  });
  assert.equal(talk.outcome.action, 'indexed');
});

test('stored values of an unexpected shape are ignored', async () => {
  const w = new World();
  const first = await w.submit({ title: 'The very same title twice' });
  for (const [key, item] of w.data) {
    if (key.startsWith('fp:')) item.value = JSON.stringify({ id: first.post.id });
    if (key.startsWith('post:')) item.value = JSON.stringify({ at: first.post.createdAt });
  }
  w.advance(1);
  const second = await w.submit({ title: 'The very same title twice' });
  assert.equal(second.outcome.action, 'indexed');
  await forgetPost(first.post.id, w.deps);
  assert.equal(w.data.has(`post:${first.post.id}`), false);
});

test('an edit frees what the post no longer contains and records what it contains now', async () => {
  const w = new World();
  const first = await w.submit({ title: 'First write-up about the product', body: `Details here: ${VIDEO}`, isSelf: true });
  // The author swaps the link for another one.
  const edited = { ...first.post, body: 'Details here: https://example.com/new-page' };
  assert.equal(await handlePostEdited(edited, settings, w.deps), true);

  w.advance(1);
  const video = await w.submit({ title: 'Just the video on its own', url: VIDEO });
  assert.equal(video.outcome.action, 'indexed');
  const page = await w.submit({ title: 'A link to the new page', url: 'https://example.com/new-page' });
  assert.deepEqual(page.outcome, { action: 'removed', reason: 'link', originalId: first.post.id });
  // The edit did not restart the first post's cooldown.
  assert.match(w.comments[0]!.text, /1 day ago/);
});

test('an edit never removes a post or takes over what another post owns', async () => {
  const w = new World();
  const first = await w.submit({ title: 'Watch this one before the weekend', url: VIDEO });
  w.advance(1);
  const second = await w.submit({ title: 'Something else entirely for now', body: 'Nothing to see yet.', isSelf: true });
  // The second post is edited to contain the first post's link.
  assert.equal(await handlePostEdited({ ...second.post, body: `Now with ${VIDEO}` }, settings, w.deps), true);
  assert.deepEqual(w.removed, []);

  w.advance(1);
  const third = await w.submit({ title: 'Third time for the same video', url: VIDEO });
  assert.deepEqual(third.outcome, { action: 'removed', reason: 'link', originalId: first.post.id });

  // An edit to a post the app is not tracking, such as one it removed, changes nothing.
  assert.equal(await handlePostEdited({ ...third.post, body: 'Edited after removal' }, settings, w.deps), false);
});

const settings = async () => DEFAULT_SETTINGS;
const settingsNotNeeded = async (): Promise<Settings> => {
  throw new Error('the settings were asked for');
};

test('a post removed by something that does not count is erased, even one its author then edits', async () => {
  const w = new World();
  const first = await w.submit({ title: 'First write-up about the product', body: `Details here: ${VIDEO}`, isSelf: true });
  // AutoModerator or another app removes it, and Reddit tells the app.
  w.posts.get(first.post.id)!.state = 'removed';
  assert.equal(await forgetPost(first.post.id, w.deps), true);
  // Its author edits it afterwards: nothing is recorded for a post that is down.
  assert.equal(await handlePostEdited({ ...first.post, body: `More details: ${VIDEO}` }, settings, w.deps), false);
  assert.deepEqual(w.about(first.post.id), [`gone:${first.post.id}`, `seen:${first.post.id}`]);

  w.advance(1);
  const again = await w.submit({ title: 'Just the video on its own', url: VIDEO });
  assert.equal(again.outcome.action, 'indexed');
  assert.deepEqual(w.removed, []);
});

/** The settings of a subreddit whose moderators have ticked the option for posts that a moderator removed. */
const REMEMBER: Settings = { ...DEFAULT_SETTINGS, checkRemovedPosts: true };

/** A moderator, a person, removes a post: Reddit shows it as removed, and tells the app who did it. */
async function removeAsModerator(w: World, id: string, current: Settings = REMEMBER): Promise<boolean> {
  w.posts.get(id)!.state = 'removed';
  return handlePostRemovedByModerator(id, current, w.deps);
}

test('a post that a moderator removed still counts as an original', async () => {
  const w = new World();
  const first = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' });
  assert.equal(await removeAsModerator(w, first.post.id), true);
  // Its record stays, with a mark that says why.
  assert.equal(recordOf(w, first.post.id).length, 3);
  assert.equal(w.data.has(`removed:${first.post.id}`), true);

  w.advance(1);
  const again = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x', authorName: 'bob' }, REMEMBER);
  assert.deepEqual(again.outcome, { action: 'removed', reason: 'link', originalId: first.post.id, originalRemoved: true });
  assert.match(w.comments[0]!.text, /u\/bob/);
  assert.match(w.comments[0]!.text, /that the moderators of r\/home removed/);
  assert.match(w.comments[0]!.text, /Please do not post it again/);
  assert.match(w.notes[0]!, /removed by a mod/);
  assert.ok(w.notes[0]!.length <= 100);

  // A moderator may still post it.
  w.moderators.add('modmary');
  const byMod = await w.submit({ title: 'The very same title twice', authorName: 'modmary' }, REMEMBER);
  assert.deepEqual(byMod.outcome, { action: 'exempt', reason: 'title', originalId: first.post.id, originalRemoved: true });
});

test('a post that a moderator removed keeps counting after its author deletes it, until Reddit says so or its time is up', async () => {
  const fields = { title: 'The very same title twice', url: 'https://example.com/x' };

  // Reddit sends no event when the author of a removed post deletes it, and
  // the app does not go looking: here, asking Reddit about the post would fail.
  const untold = new World();
  const first = await untold.submit(fields);
  await removeAsModerator(untold, first.post.id);
  untold.posts.get(first.post.id)!.state = 'deleted';
  untold.unreadable.add(first.post.id);
  untold.advance(1);
  const again = await untold.submit({ ...fields, authorName: 'bob' }, REMEMBER);
  assert.deepEqual(again.outcome, { action: 'removed', reason: 'link', originalId: first.post.id, originalRemoved: true });
  assert.match(untold.comments[0]!.text, /that the moderators of r\/home removed/);

  // The daily check leaves it alone too, though Reddit no longer lists it.
  assert.equal(await forgetUnlisted(new Set(), START, untold.time - 10 * 60 * 1000, REMEMBER, untold.deps), 0);
  assert.equal(recordOf(untold, first.post.id).length, 3);
  assert.equal(untold.data.has(`removed:${first.post.id}`), true);

  // It ends when the post's 30 days are up...
  untold.advance(30);
  for (const key of [...untold.data.keys()]) await untold.store.get(key);
  assert.deepEqual(untold.about(first.post.id), []);
  assert.equal((await untold.submit(fields, REMEMBER)).outcome.action, 'indexed');

  // ...or as soon as Reddit does send a delete event for it...
  const told = new World();
  const second = await told.submit(fields);
  await removeAsModerator(told, second.post.id);
  assert.equal(await forgetPost(second.post.id, told.deps), true);
  assert.deepEqual(told.about(second.post.id), [`gone:${second.post.id}`, `seen:${second.post.id}`]);
  assert.equal((await told.submit(fields, REMEMBER)).outcome.action, 'indexed');

  // ...or once the moderators untick the option: then the post is treated
  // like any other, and one that Reddit no longer lists is erased.
  const unticked = new World();
  const third = await unticked.submit(fields);
  await removeAsModerator(unticked, third.post.id);
  unticked.posts.get(third.post.id)!.state = 'deleted';
  unticked.advance(1);
  assert.equal(await forgetUnlisted(new Set(), START, unticked.time - 10 * 60 * 1000, DEFAULT_SETTINGS, unticked.deps), 1);
  assert.deepEqual(recordOf(unticked, third.post.id), []);
  assert.equal(unticked.data.has(`removed:${third.post.id}`), false);
  // So is one the app comes across when something repeats it.
  const fourth = await unticked.submit({ title: 'Another title that is used twice' });
  await removeAsModerator(unticked, fourth.post.id);
  unticked.posts.get(fourth.post.id)!.state = 'deleted';
  assert.equal((await unticked.submit({ title: 'Another title that is used twice' })).outcome.action, 'indexed');
  assert.deepEqual(recordOf(unticked, fourth.post.id), []);
});

test('the daily check keeps a post that a moderator removed and erases the other removed posts', async () => {
  const w = new World();
  const byMod = await w.submit({ title: 'A post that a moderator removed', url: 'https://example.com/mod' });
  await removeAsModerator(w, byMod.post.id);
  const byFilter = await w.submit({ title: 'A post that a filter removed', url: 'https://example.com/filter' });
  w.posts.get(byFilter.post.id)!.state = 'removed';
  const up = await w.submit({ title: 'A post that is still up today', url: 'https://example.com/up' });
  w.advance(1);

  // Reddit lists the first two as removed.
  const sorted = await forgetRemoved([byMod.post.id, byFilter.post.id], REMEMBER, w.deps);
  assert.deepEqual(sorted, { kept: [byMod.post.id], erased: 1 });
  // Nothing more is erased for being missing from the list.
  assert.equal(await forgetUnlisted(new Set([up.post.id, ...sorted.kept]), START, w.time - 10 * 60 * 1000, REMEMBER, w.deps), 0);
  assert.equal(recordOf(w, byMod.post.id).length, 3);
  assert.deepEqual(recordOf(w, byFilter.post.id), []);

  // Once the option is unticked, the post that the moderator removed is erased as well.
  assert.deepEqual(await forgetRemoved([byMod.post.id], DEFAULT_SETTINGS, w.deps), { kept: [], erased: 1 });
  assert.deepEqual(w.about(byMod.post.id), [`gone:${byMod.post.id}`, `seen:${byMod.post.id}`]);
});

test('a removed post that a moderator approves is an ordinary post again', async () => {
  const w = new World();
  const first = await w.submit({ title: 'The very same title twice' });
  await removeAsModerator(w, first.post.id);
  // The moderator changes their mind.
  w.posts.get(first.post.id)!.state = 'up';
  assert.deepEqual(await handlePostApproved(first.post.id, settingsNotNeeded, w.deps), { unmarked: true, recorded: false, commentDeleted: false });
  assert.deepEqual(await handlePostApproved(first.post.id, settingsNotNeeded, w.deps), { unmarked: false, recorded: false, commentDeleted: false });

  const again = await w.submit({ title: 'The very same title twice' });
  assert.deepEqual(again.outcome, { action: 'removed', reason: 'title', originalId: first.post.id });
  assert.match(w.comments[0]!.text, /can be shared again once 30 days/);
});

test('a mark left by a missed approval is dropped once the post is seen to be up', async () => {
  const w = new World();
  const first = await w.submit({ title: 'The very same title twice' });
  await removeAsModerator(w, first.post.id);
  // It was approved again, but the app never heard about it.
  w.posts.get(first.post.id)!.state = 'up';
  const second = await w.submit({ title: 'The very same title twice' });
  assert.deepEqual(second.outcome, { action: 'removed', reason: 'title', originalId: first.post.id });
  assert.equal(w.data.has(`removed:${first.post.id}`), false);
});

test('the option for removed posts is off unless it is ticked, and it ends with the cooldown', async () => {
  assert.equal(DEFAULT_SETTINGS.checkRemovedPosts, false);
  const w = new World();
  const first = await w.submit({ title: 'The very same title twice' });
  await removeAsModerator(w, first.post.id);
  // The moderators untick the option, which is also how the app comes.
  const allowed = await w.submit({ title: 'The very same title twice' });
  assert.equal(allowed.outcome.action, 'indexed');
  // With the option off, the removed post was erased as soon as the app came across it.
  assert.equal(w.data.has(`removed:${first.post.id}`), false);
  assert.deepEqual(recordOf(w, first.post.id), []);

  const other = await w.submit({ title: 'Another title that is used twice' });
  await removeAsModerator(w, other.post.id);
  w.advance(31);
  for (const key of [...w.data.keys()]) await w.store.get(key);
  assert.deepEqual(w.about(other.post.id), []);
  const late = await w.submit({ title: 'Another title that is used twice' }, REMEMBER);
  assert.equal(late.outcome.action, 'indexed');
  assert.deepEqual(w.removed, []);
});

test('a post that a moderator removed is forgotten 30 days after that at the latest, whatever the cooldown', async () => {
  const w = new World();
  const quarter = { ...QUARTER, checkRemovedPosts: true };
  const first = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' }, quarter);
  // The daily check read it on day 10, while it was up. Then a moderator removed it.
  w.advance(10);
  assert.equal(await indexExistingPosts([first.post], quarter, w.deps), 1);
  assert.equal(await removeAsModerator(w, first.post.id, quarter), true);

  // 29 days after the removal it still counts...
  w.advance(29);
  const early = await w.submit({ title: 'Other words for the same link', url: 'https://example.com/x' }, quarter);
  assert.deepEqual(early.outcome, { action: 'removed', reason: 'link', originalId: first.post.id, originalRemoved: true });

  // ...and two days later nothing is left of it, though the cooldown is 90 days.
  w.advance(2);
  for (const key of [...w.data.keys()]) await w.store.get(key);
  assert.deepEqual(w.about(first.post.id), []);
  const late = await w.submit({ title: 'More words for the same link', url: 'https://example.com/x' }, quarter);
  assert.equal(late.outcome.action, 'indexed');
});

test('a removal by a moderator is remembered even for a post the app had not recorded', async () => {
  const w = new World();
  // A filter held the post back when it came in, and the app erased it. Then a moderator removes it for good.
  const held = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' });
  w.posts.get(held.post.id)!.state = 'removed';
  await forgetPost(held.post.id, w.deps);
  assert.deepEqual(recordOf(w, held.post.id), []);
  assert.equal(await handlePostRemovedByModerator(held.post.id, REMEMBER, w.deps), true);
  assert.equal(recordOf(w, held.post.id).length, 3);
  assert.equal(w.data.has(`gone:${held.post.id}`), false);

  const again = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' }, REMEMBER);
  assert.deepEqual(again.outcome, { action: 'removed', reason: 'link', originalId: held.post.id, originalRemoved: true });

  // Not for a post that was deleted meanwhile, that is up again, or that cannot be read.
  const deleted = w.make({ title: 'A post that was deleted meanwhile' });
  w.posts.get(deleted.id)!.state = 'deleted';
  assert.equal(await handlePostRemovedByModerator(deleted.id, REMEMBER, w.deps), false);
  assert.deepEqual(w.about(deleted.id), [`gone:${deleted.id}`]);
  const backUp = w.make({ title: 'A post that was approved meanwhile' });
  assert.equal(await handlePostRemovedByModerator(backUp.id, REMEMBER, w.deps), false);
  assert.deepEqual(w.about(backUp.id), []);
  const hidden = w.make({ title: 'A post that Reddit will not show' });
  w.posts.get(hidden.id)!.state = 'removed';
  w.unreadable.add(hidden.id);
  assert.equal(await handlePostRemovedByModerator(hidden.id, REMEMBER, w.deps), false);
  assert.deepEqual(w.about(hidden.id), []);
});

test('a post deleted at the moment a moderator removes it is not remembered', async () => {
  const w = new World();
  const first = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' });
  w.posts.get(first.post.id)!.state = 'removed';
  // The delete is handled just as the mark is being written.
  w.deleteDuring(first.post.id, 'removed:');
  assert.equal(await handlePostRemovedByModerator(first.post.id, REMEMBER, w.deps), false);
  assert.deepEqual(w.about(first.post.id), [`gone:${first.post.id}`, `seen:${first.post.id}`]);
});

test('a removal event for a post that is up again does not mark it', async () => {
  const w = new World();
  const first = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' });
  // A moderator removed it and approved it again at once; the removal event is handled last.
  assert.equal(await handlePostRemovedByModerator(first.post.id, REMEMBER, w.deps), false);
  assert.equal(w.data.has(`removed:${first.post.id}`), false);
  const again = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' }, REMEMBER);
  assert.deepEqual(again.outcome, { action: 'removed', reason: 'link', originalId: first.post.id });
  assert.match(w.comments[0]!.text, /can be shared again once 30 days/);

  // When Reddit cannot be asked, the event is taken at its word for a post the app has recorded.
  const second = await w.submit({ title: 'Another title that is used twice' });
  w.posts.get(second.post.id)!.state = 'removed';
  w.unreadable.add(second.post.id);
  assert.equal(await handlePostRemovedByModerator(second.post.id, REMEMBER, w.deps), true);
  assert.equal(w.data.has(`removed:${second.post.id}`), true);
});

test('the daily check writes nothing for a removed post it holds nothing about', async () => {
  const w = new World();
  const up = await w.submit({ title: 'A post that is still up today', url: 'https://example.com/up' });
  const before = JSON.stringify([[...w.data], [...w.sorted].map(([key, set]) => [key, [...set]])]);
  // Most removed posts in Reddit's list are ones the app never recorded, or has already erased.
  assert.deepEqual(await forgetRemoved(['t3_never1', 't3_never2'], REMEMBER, w.deps), { kept: [], erased: 0 });
  assert.equal(JSON.stringify([[...w.data], [...w.sorted].map(([key, set]) => [key, [...set]])]), before);
  assert.equal(recordOf(w, up.post.id).length, 3);
});

test('an edit of a post that a moderator removed is read from Reddit, not from the event', async () => {
  const w = new World();
  const first = await w.submit({ title: 'First write-up about the product', body: `Details here: ${VIDEO}`, isSelf: true });
  await removeAsModerator(w, first.post.id);
  // Its author edits the link out. The event carries blanked-out text, the same before and after.
  w.contents.set(first.post.id, { ...first.post, body: 'Details here: https://example.com/new-page' });
  const event = { ...first.post, body: '[removed]' };
  assert.equal(await handlePostEdited(event, settings, w.deps, true), true);

  w.advance(1);
  const video = await w.submit({ title: 'Just the video on its own', url: VIDEO });
  assert.equal(video.outcome.action, 'indexed');
  const page = await w.submit({ title: 'A link to the new page', url: 'https://example.com/new-page' }, REMEMBER);
  assert.deepEqual(page.outcome, { action: 'removed', reason: 'link', originalId: first.post.id, originalRemoved: true });

  // If the post turns out to be deleted, the edit event is what gets it erased.
  w.posts.get(first.post.id)!.state = 'deleted';
  assert.equal(await handlePostEdited(event, settings, w.deps, true), false);
  assert.deepEqual(recordOf(w, first.post.id), []);

  // So is one that cannot be read: there is no telling what it says now.
  const second = await w.submit({ title: 'Second write-up about the product', body: `More details here: ${VIDEO}`, isSelf: true });
  await removeAsModerator(w, second.post.id);
  w.unreadable.add(second.post.id);
  assert.equal(await handlePostEdited({ ...second.post, body: '[removed]' }, settings, w.deps), false);
  assert.deepEqual(recordOf(w, second.post.id), []);
  assert.equal(w.data.has(`removed:${second.post.id}`), false);

  // For an ordinary post, an event that shows the same text before and after changes nothing.
  const before = JSON.stringify([...w.data]);
  assert.equal(await handlePostEdited({ ...video.post, body: 'ignored' }, settingsNotNeeded, w.deps, true), false);
  assert.equal(JSON.stringify([...w.data]), before);
});

test('erasing everything leaves nothing behind, and the app keeps working', async () => {
  const w = new World();
  // One of everything the app stores: recorded posts, a repost it removed and
  // commented on, a post that a moderator removed, one that was deleted, and
  // one that a moderator approved.
  await w.submit({ title: 'First write-up about the product', body: `${LONG_TEXT} ${VIDEO}`, isSelf: true });
  const repost = await w.submit({ title: 'Just the video on its own', url: VIDEO, authorName: 'bob' });
  assert.equal(repost.outcome.action, 'removed');
  const byMod = await w.submit({ title: 'A post that a moderator removed', url: 'https://example.com/mod' });
  await removeAsModerator(w, byMod.post.id);
  const deleted = await w.submit({ title: 'A post that its author deleted', url: 'https://example.com/deleted' });
  await forgetPost(deleted.post.id, w.deps);
  const approved = w.make({ title: 'A post that a moderator approved', url: 'https://example.com/approved' });
  await handlePostApproved(approved.id, settings, w.deps);
  const kinds = new Set([...w.data.keys()].map((key) => key.split(':')[0]));
  assert.deepEqual([...kinds].sort(), ['comment', 'fp', 'gone', 'post', 'removed', 'seen']);
  const stored = w.data.size;

  // Every key, and the list of recorded posts.
  assert.equal(await eraseEverything(w.deps), stored + 1);
  assert.equal(w.data.size, 0);
  assert.equal(w.sorted.size, 0);
  assert.equal(await eraseEverything(w.deps), 0);

  // Nothing is an original any more, and a new post is recorded as usual.
  const again = await w.submit({ title: 'Just the video on its own', url: VIDEO });
  assert.equal(again.outcome.action, 'indexed');
  assert.equal(w.listed().length, 1);
});

test('erasing works through a long list of keys', async () => {
  const w = new World();
  for (let n = 0; n < 400; n++) {
    await w.submit({ title: `A post with the number ${n} in its title`, url: `https://example.com/page-${n}` });
  }
  // A record, two fingerprints and a marker for each post.
  assert.equal(w.data.size, 1600);
  assert.equal(await eraseEverything(w.deps), 1601);
  assert.equal(w.data.size, 0);
  assert.equal(w.sorted.size, 0);
});

test('the list of keys drops the names of keys that have run out', async () => {
  const w = new World();
  await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' });
  assert.equal(w.sorted.get('keys')!.size, 4);
  w.advance(32);
  const later = w.make({ title: 'A later title that is used only once' });
  await indexExistingPosts([later], DEFAULT_SETTINGS, w.deps);
  for (const key of [...w.data.keys()]) await w.store.get(key);
  assert.deepEqual([...w.sorted.get('keys')!.keys()].sort(), [...w.data.keys()].sort());
  assert.equal(w.data.size, 2);
});

test('a removed post that a moderator approves is recorded again', async () => {
  const w = new World();
  const first = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' });
  w.posts.get(first.post.id)!.state = 'removed';
  await forgetPost(first.post.id, w.deps);

  // While Reddit still shows it as removed, nothing is recorded.
  assert.deepEqual(await handlePostApproved(first.post.id, settingsNotNeeded, w.deps), { unmarked: false, recorded: false, commentDeleted: false });
  assert.deepEqual(w.about(first.post.id), [`gone:${first.post.id}`, `seen:${first.post.id}`]);

  w.advance(1);
  w.posts.get(first.post.id)!.state = 'up';
  assert.deepEqual(await handlePostApproved(first.post.id, settings, w.deps), { unmarked: false, recorded: true, commentDeleted: false });
  assert.equal(w.data.has(`gone:${first.post.id}`), false);
  // Approving a post that is recorded changes nothing, and does not need the settings.
  const before = JSON.stringify([...w.data]);
  assert.deepEqual(await handlePostApproved(first.post.id, settingsNotNeeded, w.deps), { unmarked: false, recorded: false, commentDeleted: false });
  assert.equal(JSON.stringify([...w.data]), before);

  const again = await w.submit({ title: 'Other words for the same link', url: 'https://example.com/x', authorName: 'bob' });
  assert.deepEqual(again.outcome, { action: 'removed', reason: 'link', originalId: first.post.id });
  // The cooldown still runs from the day the post was made.
  assert.match(w.comments[0]!.text, /1 day ago/);

  // Removed again, it is erased again.
  assert.equal(await forgetPost(first.post.id, w.deps), true);
  assert.deepEqual(w.about(first.post.id), [`gone:${first.post.id}`, `seen:${first.post.id}`]);
});

test('approving a post the app removed lets it stay, deletes the comment and records what is free', async () => {
  const w = new World();
  const original = await w.submit({ title: 'The very same title twice', url: 'https://example.com/a' });
  const repost = await w.submit({ title: 'The very same title twice', url: 'https://example.com/b' });
  assert.equal(repost.outcome.action, 'removed');
  // Reddit reports the app's own removal like any other, and the app erases the repost.
  assert.equal(await forgetPost(repost.post.id, w.deps), false);

  // A moderator decides the repost is fine after all.
  w.posts.get(repost.post.id)!.state = 'up';
  assert.deepEqual(await handlePostApproved(repost.post.id, settings, w.deps), { unmarked: false, recorded: true, commentDeleted: true });
  assert.deepEqual(w.deletedComments, ['t1_c1']);
  assert.deepEqual(await handlePostApproved(repost.post.id, settings, w.deps), { unmarked: false, recorded: false, commentDeleted: false });
  assert.deepEqual(w.deletedComments, ['t1_c1']);
  assert.deepEqual(w.removed, [repost.post.id]);

  // The title still belongs to the original; the repost's own link is now recorded.
  const byTitle = await w.submit({ title: 'The very same title twice', url: 'https://example.com/c' });
  assert.deepEqual(byTitle.outcome, { action: 'removed', reason: 'title', originalId: original.post.id });
  const byLink = await w.submit({ title: 'Other words for the second link', url: 'https://example.com/b' });
  assert.deepEqual(byLink.outcome, { action: 'removed', reason: 'link', originalId: repost.post.id });
});

test('an approved post is never removed, even when its submit event arrives after the approval', async () => {
  const w = new World();
  await w.submit({ title: 'The very same title twice' });
  // Held back by a filter and then approved by a moderator, all before its submit event is handled.
  const held = w.make({ title: 'The very same title twice' });
  await forgetPost(held.id, w.deps);
  assert.deepEqual(await handlePostApproved(held.id, settings, w.deps), { unmarked: false, recorded: true, commentDeleted: false });
  assert.equal((await handleNewPost(held, DEFAULT_SETTINGS, w.deps)).action, 'duplicate-event');
  assert.deepEqual(w.removed, []);
});

test('approving a post that is past the cooldown, or that cannot be read, records nothing', async () => {
  const w = new World();
  const old = w.make({ title: 'Something from long ago here' });
  w.advance(31);
  assert.deepEqual(await handlePostApproved(old.id, settings, w.deps), { unmarked: false, recorded: false, commentDeleted: false });
  assert.equal(w.data.has(`post:${old.id}`), false);

  const hidden = w.make({ title: 'Something that cannot be read' });
  w.unreadable.add(hidden.id);
  await assert.rejects(handlePostApproved(hidden.id, settings, w.deps));
  assert.equal(w.data.has(`post:${hidden.id}`), false);
});

test('erasing many posts at once counts the ones that were recorded', async () => {
  const w = new World();
  const ids: string[] = [];
  for (let n = 0; n < 30; n++) {
    ids.push((await w.submit({ title: `A removed post with the number ${n}`, url: `https://example.com/removed-${n}` })).post.id);
  }
  const kept = await w.submit({ title: 'A post that is still up today', url: 'https://example.com/up' });
  assert.equal(await forgetPosts([...ids, 't3_neverseen'], w.deps), 30);
  assert.deepEqual([...w.data.keys()].filter((key) => key.startsWith('fp:') || key.startsWith('post:')).sort(), w.about(kept.post.id).filter((key) => !key.startsWith('seen:')));
});

test('a failed removal can be retried', async () => {
  const w = new World();
  await w.submit({ title: 'The very same title twice' });
  const repeat = w.make({ title: 'The very same title twice' });
  const remove = w.deps.reddit.remove;
  w.deps.reddit.remove = async () => {
    throw new Error('reddit is down');
  };
  await assert.rejects(handleNewPost(repeat, DEFAULT_SETTINGS, w.deps));
  w.deps.reddit.remove = remove;
  const retry = await handleNewPost(repeat, DEFAULT_SETTINGS, w.deps);
  assert.equal(retry.action, 'removed');
});

test('no comment is left when comments are switched off', async () => {
  const w = new World();
  const quiet = { ...DEFAULT_SETTINGS, leaveComment: false };
  await w.submit({ title: 'The very same title twice' }, quiet);
  const second = await w.submit({ title: 'The very same title twice' }, quiet);
  assert.equal(second.outcome.action, 'removed');
  assert.equal(w.comments.length, 0);
});

test('existing posts are recorded on install, oldest first, without removing anything', async () => {
  const w = new World();
  const ancient = w.make({ title: 'Something from long ago here', url: 'https://example.com/ancient' });
  w.advance(40);
  const older = w.make({ title: 'The very same title twice', url: 'https://example.com/a' });
  w.advance(5);
  const newer = w.make({ title: 'The very same title twice', url: 'https://example.com/b' });
  w.advance(1);

  const count = await indexExistingPosts([newer, ancient, older], DEFAULT_SETTINGS, w.deps);
  assert.equal(count, 2);
  assert.deepEqual(w.removed, []);

  const byTitle = await w.submit({ title: 'The very same title twice' });
  assert.deepEqual(byTitle.outcome, { action: 'removed', reason: 'title', originalId: older.id });
  const byLink = await w.submit({ title: 'Completely different words', url: 'https://example.com/b' });
  assert.deepEqual(byLink.outcome, { action: 'removed', reason: 'link', originalId: newer.id });
  const stale = await w.submit({ title: 'Something from long ago here', url: 'https://example.com/ancient' });
  assert.equal(stale.outcome.action, 'indexed');
});

test('a rescan drops what a post no longer has, and what the settings no longer compare', async () => {
  const w = new World();
  const first = await w.submit({ title: 'First write-up about the product', body: `Details here: ${VIDEO}`, isSelf: true });
  // The post was edited and the app never heard about it; a rescan reads it as it is now.
  const now = { ...first.post, body: 'Details here: https://example.com/new-page' };
  assert.equal(await indexExistingPosts([now], DEFAULT_SETTINGS, w.deps), 1);
  const video = await w.submit({ title: 'Just the video on its own', url: VIDEO });
  assert.equal(video.outcome.action, 'indexed');
  const page = await w.submit({ title: 'A link to the new page', url: 'https://example.com/new-page' });
  assert.deepEqual(page.outcome, { action: 'removed', reason: 'link', originalId: first.post.id });

  // With the link rule switched off, a rescan leaves no link fingerprint behind for that post.
  const links = () => w.about(first.post.id).filter((key) => key.startsWith('fp:link:'));
  assert.equal(links().length, 1);
  await indexExistingPosts([now], { ...DEFAULT_SETTINGS, checkLinks: false }, w.deps);
  assert.equal(links().length, 0);
  // So erasing the post later leaves nothing at all.
  await forgetPost(first.post.id, w.deps);
  assert.deepEqual(w.about(first.post.id), [`gone:${first.post.id}`, `seen:${first.post.id}`]);
});

/** The keys that hold a post's record and fingerprints. */
const recordOf = (w: World, id: string) => w.about(id).filter((key) => key.startsWith('fp:') || key.startsWith('post:'));

test('a recorded post that Reddit no longer lists is erased, as far back as the list was read', async () => {
  const w = new World();
  const old = await w.submit({ title: 'A post from before the list begins', url: 'https://example.com/old' });
  w.advance(5);
  const deleted = await w.submit({ title: 'A post deleted without a word', url: 'https://example.com/deleted' });
  const up = await w.submit({ title: 'A post that is still up today', url: 'https://example.com/up' });
  w.advance(1);
  const fresh = await w.submit({ title: 'A post made only a moment ago', url: 'https://example.com/fresh' });
  assert.deepEqual(w.listed(), [old.post.id, deleted.post.id, up.post.id, fresh.post.id]);

  // Reddit's list shows only one of them as up. It was read back to day 3,
  // and a post made in the last ten minutes may not be in it yet.
  const erased = await forgetUnlisted(new Set([up.post.id]), START + 3 * DAY, w.time - 10 * 60 * 1000, DEFAULT_SETTINGS, w.deps);
  assert.equal(erased, 1);
  assert.deepEqual(recordOf(w, deleted.post.id), []);
  assert.equal(w.data.has(`gone:${deleted.post.id}`), true);
  assert.deepEqual(w.listed(), [old.post.id, up.post.id, fresh.post.id]);
  for (const kept of [old, up, fresh]) assert.equal(recordOf(w, kept.post.id).length, 3);

  // What was deleted can be posted again.
  const again = await w.submit({ title: 'A post deleted without a word', url: 'https://example.com/deleted' });
  assert.equal(again.outcome.action, 'indexed');

  // A list that could not be read says nothing, and erases nothing.
  assert.equal(await forgetUnlisted(new Set(), Infinity, w.time, DEFAULT_SETTINGS, w.deps), 0);
  assert.equal(w.listed().length, 4);
});

test('the list of recorded posts follows the records', async () => {
  const w = new World();
  const first = await w.submit({ title: 'The very same title twice' });
  // A repost that the app removes is never recorded, so it is never listed.
  const repost = await w.submit({ title: 'The very same title twice' });
  assert.equal(repost.outcome.action, 'removed');
  assert.deepEqual(w.listed(), [first.post.id]);
  await forgetPost(first.post.id, w.deps);
  assert.deepEqual(w.listed(), []);

  // An entry whose post is past the cooldown is dropped by the next rescan.
  await w.submit({ title: 'Another title that is used only once' });
  w.advance(32);
  const later = w.make({ title: 'A third title that is used only once' });
  assert.equal(await indexExistingPosts([later], DEFAULT_SETTINGS, w.deps), 1);
  assert.deepEqual(w.listed(), [later.id]);
});

const MONTH = 30 * DAY;
const QUARTER = { ...DEFAULT_SETTINGS, cooldownDays: 90 };

test('nothing is kept for more than 30 days without the post being read again', async () => {
  const w = new World();
  const first = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' }, QUARTER);
  assert.ok([...w.data.values()].every((item) => item.expiresAt !== undefined && item.expiresAt <= w.time + MONTH));
  w.advance(29);
  const early = await w.submit({ title: 'The very same title twice' }, QUARTER);
  assert.deepEqual(early.outcome, { action: 'removed', reason: 'title', originalId: first.post.id });
  // The removal comment's id is not kept longer than that either.
  assert.ok([...w.data.values()].every((item) => item.expiresAt !== undefined && item.expiresAt <= w.time + MONTH));

  // Say the post was deleted and Reddit never told the app. Nothing has read
  // it since, so after 30 days everything about it is gone anyway.
  w.advance(2);
  for (const key of [...w.data.keys()]) await w.store.get(key);
  assert.deepEqual(w.about(first.post.id), []);
});

test('a post that is still up is kept through a longer cooldown as long as it is read again', async () => {
  const w = new World();
  const first = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' }, QUARTER);
  // The daily pass finds it among the newest posts on day 29...
  w.advance(29);
  assert.equal(await indexExistingPosts([first.post], QUARTER, w.deps), 1);
  // ...so on day 31 it still counts, past the 30 days it was first recorded for.
  w.advance(2);
  const second = await w.submit({ title: 'Other words for the same link', url: 'https://example.com/x' }, QUARTER);
  assert.deepEqual(second.outcome, { action: 'removed', reason: 'link', originalId: first.post.id });

  for (const day of [50, 70]) {
    w.time = START + day * DAY;
    await indexExistingPosts([first.post], QUARTER, w.deps);
    assert.ok(w.about(first.post.id).every((key) => w.data.get(key)!.expiresAt! <= w.time + MONTH), `day ${day}`);
  }
  w.time = START + 85 * DAY;
  const third = await w.submit({ title: 'The very same title twice' }, QUARTER);
  assert.deepEqual(third.outcome, { action: 'removed', reason: 'title', originalId: first.post.id });

  // It is not kept past the cooldown itself.
  w.time = START + 91 * DAY;
  for (const key of [...w.data.keys()]) await w.store.get(key);
  assert.deepEqual(w.about(first.post.id), []);
  const fourth = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' }, QUARTER);
  assert.equal(fourth.outcome.action, 'indexed');
});

test('what an earlier version recorded for longer is cut back to 30 days when the post is read again', async () => {
  const w = new World();
  const first = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' }, QUARTER);
  // As an earlier version stored it: good for the whole cooldown, with a mark that the post was removed.
  for (const key of w.about(first.post.id)) w.data.get(key)!.expiresAt = START + 90 * DAY;
  w.data.set(`removed:${first.post.id}`, { value: '1', expiresAt: START + 366 * DAY });

  w.advance(1);
  assert.equal(await indexExistingPosts([first.post], QUARTER, w.deps), 1);
  const recorded = w.about(first.post.id).filter((key) => key.startsWith('fp:') || key.startsWith('post:'));
  assert.equal(recorded.length, 3);
  assert.ok(recorded.every((key) => w.data.get(key)!.expiresAt === w.time + MONTH));

  // And when the post goes, the old mark goes with it.
  await forgetPost(first.post.id, w.deps);
  assert.equal(w.data.has(`removed:${first.post.id}`), false);
});

test('records expire with the cooldown', async () => {
  const w = new World();
  await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' });
  w.advance(32);
  for (const key of [...w.data.keys()]) await w.store.get(key);
  assert.equal(w.data.size, 0);
});

test('settings fall back to defaults and are clamped', () => {
  assert.deepEqual(parseSettings(undefined), DEFAULT_SETTINGS);
  const parsed = parseSettings({ cooldownDays: 0, checkTitles: false, minTitleLength: '', removalMessage: '  ' });
  assert.equal(parsed.cooldownDays, 1);
  assert.equal(parsed.checkTitles, false);
  assert.equal(parsed.minTitleLength, DEFAULT_SETTINGS.minTitleLength);
  assert.equal(parsed.removalMessage, DEFAULT_SETTINGS.removalMessage);
  assert.equal(parseSettings({ cooldownDays: 14 }).cooldownDays, 14);
  assert.deepEqual(parseSettings({ ignoredRemovers: 'u/FloodBot, other_bot  /u/Third,' }).ignoredRemovers, [
    'floodbot',
    'other_bot',
    'third',
  ]);
  assert.equal(parseSettings({ checkRemovedPosts: false }).checkRemovedPosts, false);
});
