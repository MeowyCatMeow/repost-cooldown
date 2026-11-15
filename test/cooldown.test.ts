import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SETTINGS,
  handleNewPost,
  handlePostDeleted,
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

/** A stand-in for one subreddit: a clock, a key-value store, and its posts. */
class World {
  time = START;
  data = new Map<string, { value: string; expiresAt?: number }>();
  posts = new Map<string, PostInfo>();
  moderators = new Set<string>();
  removed: string[] = [];
  comments: Array<{ id: string; text: string }> = [];
  notes: string[] = [];
  unreadable = new Set<string>();
  nextId = 1;

  store: Store = {
    get: async (key) => {
      const item = this.data.get(key);
      if (!item) return undefined;
      if (item.expiresAt !== undefined && item.expiresAt <= this.time) {
        this.data.delete(key);
        return undefined;
      }
      return item.value;
    },
    set: async (key, value, options) => {
      if (options?.nx && (await this.store.get(key)) !== undefined) return '';
      this.data.set(key, { value, expiresAt: options?.expiration?.getTime() });
      return 'OK';
    },
    del: async (...keys) => {
      for (const key of keys) this.data.delete(key);
    },
  };

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
      isModerator: async (username) => this.moderators.has(username),
      remove: async (id) => {
        this.removed.push(id);
        const info = this.posts.get(id);
        if (info) info.removed = true;
      },
      comment: async (id, text) => {
        this.comments.push({ id, text });
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
    this.posts.set(id, { id, subredditId, createdAt: post.createdAt, removed: false, permalink: `/r/home/comments/${id.slice(3)}/slug/` });
    return post;
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

test('a removed original does not block a new post', async () => {
  const w = new World();
  const first = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' });
  w.posts.get(first.post.id)!.removed = true; // a moderator removed it
  w.advance(1);
  const second = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' });
  assert.equal(second.outcome.action, 'indexed');

  // The replacement is now the original.
  w.advance(1);
  const third = await w.submit({ title: 'The very same title twice', url: 'https://example.com/y' });
  assert.deepEqual(third.outcome, { action: 'removed', reason: 'title', originalId: second.post.id });
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
  await handlePostDeleted(first.post.id, w.deps);
  const second = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' });
  assert.equal(second.outcome.action, 'indexed');

  // Deleting a post that owns nothing must not free someone else's keys.
  const third = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' });
  assert.equal(third.outcome.action, 'removed');
  await handlePostDeleted(third.post.id, w.deps);
  const fourth = await w.submit({ title: 'The very same title twice', url: 'https://example.com/x' });
  assert.equal(fourth.outcome.action, 'removed');
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
});
