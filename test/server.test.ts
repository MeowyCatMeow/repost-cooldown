/**
 * Runs the real entry point, src/server/index.ts, with test/fake-devvit.ts in
 * place of Devvit, and calls its endpoints over HTTP as Reddit does.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import type { AddressInfo } from 'node:net';
import { after, afterEach, beforeEach, test } from 'node:test';
import { parseSettings } from '../src/core/cooldown.ts';

const fakeUrl = new URL('./fake-devvit.ts', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@devvit/web/server') return { url: fakeUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const { addPost, reset, state } = await import('./fake-devvit.ts');
// The app's own log lines would drown the test report.
console.log = () => {};
console.error = () => {};
await import('../src/server/index.ts');

const server = state.server!;
if (!server.listening) await once(server, 'listening');
const { port } = server.address() as AddressInfo;
after(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => reset());
// Whatever a test did, every key the app wrote must be on its list of keys:
// that list is what lets a moderator erase everything.
afterEach(() => {
  const listed = state.sorted.get('keys');
  assert.deepEqual([...state.redis.keys()].filter((key) => !listed?.has(key)), []);
});

const DAY = 24 * 60 * 60 * 1000;

async function call(path: string, body: unknown = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

let nextId = 1;

/** Creates a post on the fake Reddit and returns the event Reddit sends for it. */
function post(fields: { title: string; url?: string; text?: string; author?: string; createdAt?: number }) {
  const id = `t3_s${nextId++}`;
  const permalink = `/r/home/comments/${id.slice(3)}/slug/`;
  const url = fields.url ?? `https://www.reddit.com${permalink}`;
  const createdAt = fields.createdAt ?? Date.now();
  const author = fields.author ?? 'alice';
  addPost({ id, title: fields.title, url, body: fields.text ?? '', authorName: author, permalink, createdAt: new Date(createdAt) });
  const event = {
    post: {
      id,
      title: fields.title,
      url,
      selftext: fields.text ?? '',
      isSelf: fields.url === undefined,
      createdAt,
      subredditId: 't5_home',
      crosspostParentId: '',
      permalink,
    },
    author: { id: 't2_author', name: author },
    subreddit: { id: 't5_home', name: 'home' },
  };
  return { id, event };
}

const submit = (event: object) => call('/internal/triggers/post-submit', { type: 'PostSubmit', ...event });

test('a repost is removed with a pinned comment and a mod note', async () => {
  const first = post({ title: 'Screenshot of the day from the app', url: 'https://i.redd.it/one.png' });
  assert.equal((await submit(first.event)).status, 200);
  const second = post({ title: 'Screenshot of the day from the app', url: 'https://i.redd.it/two.png', author: 'bob' });
  assert.equal((await submit(second.event)).status, 200);

  assert.deepEqual(state.removed, [second.id]);
  assert.equal(state.comments.length, 1);
  assert.equal(state.comments[0]!.pinned, true);
  assert.match(state.comments[0]!.text, /u\/bob/);
  assert.equal(state.notes.length, 1);
});

test('when the settings cannot be read, nothing is removed and the event can be sent again', async () => {
  const first = post({ title: 'Screenshot of the day from the app', url: 'https://i.redd.it/one.png' });
  await submit(first.event);
  // The moderators have switched the title rule off, and then the settings cannot be read.
  state.settings = { checkTitles: false };
  state.settingsFail = true;
  const second = post({ title: 'Screenshot of the day from the app', url: 'https://i.redd.it/two.png' });
  assert.equal((await submit(second.event)).status, 500);
  assert.deepEqual(state.removed, []);
  assert.equal(state.comments.length, 0);

  // Once the settings can be read again, the same event is handled by the moderators' rules.
  state.settingsFail = false;
  assert.equal((await submit(second.event)).status, 200);
  assert.deepEqual(state.removed, []);
});

test('a comment that cannot be pinned is still left, and the removal still gets its note', async () => {
  state.distinguishFail = true;
  await submit(post({ title: 'Screenshot of the day from the app', url: 'https://i.redd.it/one.png' }).event);
  const second = post({ title: 'Screenshot of the day from the app', url: 'https://i.redd.it/two.png' });
  assert.equal((await submit(second.event)).status, 200);
  assert.deepEqual(state.removed, [second.id]);
  assert.equal(state.comments.length, 1);
  assert.equal(state.comments[0]!.pinned, false);
  assert.equal(state.notes.length, 1);
});

test('an edited post is read again', async () => {
  const link = 'https://example.com/product-page';
  const first = post({ title: 'First write-up about the product', text: `Details here: ${link}` });
  await submit(first.event);
  // The author edits the link out.
  const edited = { ...first.event, post: { ...first.event.post, selftext: 'Details removed.' }, previousBody: `Details here: ${link}` };
  assert.equal((await call('/internal/triggers/post-update', { type: 'PostUpdate', ...edited })).status, 200);

  const second = post({ title: 'The product page on its own', url: link });
  await submit(second.event);
  assert.deepEqual(state.removed, []);
});

/** A moderator action as Reddit reports it. Account type 1 is a person, 3 is an app; Reddit may send the name instead. */
const modAction = (action: string, id: string, moderator: { name: string; accountType: number | string }) =>
  call('/internal/triggers/mod-action', {
    type: 'ModAction',
    action,
    targetPost: { id },
    moderator: { id: 't2_moderator', ...moderator },
  });

/** The stored keys that hold anything made from a post's title, text or links, or that name the post as their owner. */
function kept(id: string): string[] {
  return [...state.redis]
    .filter(([key, item]) => key === `post:${id}` || (key.startsWith('fp:') && item.value.includes(`"${id}"`)))
    .map(([key]) => key);
}

test('a post removed by a person still counts; one removed by an app or a bot is erased', async () => {
  // The moderators have ticked the option, and named a bot that runs under an ordinary account.
  state.settings = { checkRemovedPosts: true, ignoredRemovers: 'u/Ordinary-Bot' };
  const cases = [
    { title: 'A title removed by a person', action: 'removelink', remover: { name: 'modmary', accountType: 1 }, counts: true },
    { title: 'A title marked as spam by a person', action: 'spamlink', remover: { name: 'modmary', accountType: 'ACCOUNT_TYPE_USER' }, counts: true },
    { title: 'A title removed by another app', action: 'removelink', remover: { name: 'flood-assistant', accountType: 3 }, counts: false },
    { title: 'A title removed by AutoModerator', action: 'removelink', remover: { name: 'AutoModerator', accountType: 1 }, counts: false },
    { title: 'A title removed by a named bot', action: 'removelink', remover: { name: 'ordinary-bot', accountType: 1 }, counts: false },
    { title: 'A title removed by an unknown kind', action: 'removelink', remover: { name: 'someone', accountType: 0 }, counts: false },
  ];
  const originals: string[] = [];
  for (const [index, { title, action, remover, counts }] of cases.entries()) {
    const original = post({ title, url: `https://i.redd.it/original${index}.png` });
    await submit(original.event);
    state.posts.get(original.id)!.removed = true;
    // Reddit reports the removal as a delete event first. That alone decides nothing.
    await call('/internal/triggers/post-delete', { type: 'PostDelete', postId: original.id, source: 3 });
    assert.equal(kept(original.id).length, 3);
    // The moderator action says who removed it.
    assert.equal((await modAction(action, original.id, remover)).status, 200);
    assert.equal(kept(original.id).length, counts ? 3 : 0, title);
    assert.equal(state.redis.has(`removed:${original.id}`), counts, title);
    originals.push(original.id);
  }
  // Something a moderator does that is not a removal changes nothing.
  const locked = post({ title: 'A title on a post that gets locked', url: 'https://i.redd.it/locked.png' });
  await submit(locked.event);
  await modAction('lock', locked.id, cases[0]!.remover);
  assert.equal(kept(locked.id).length, 3);
  assert.equal(state.redis.has(`removed:${locked.id}`), false);

  const expected: string[] = [];
  for (const [index, { title, counts }] of cases.entries()) {
    const repost = post({ title, url: `https://i.redd.it/repost${index}.png`, author: 'bob' });
    await submit(repost.event);
    if (counts) expected.push(repost.id);
  }
  assert.deepEqual(state.removed, expected);
  assert.match(state.comments[0]!.text, /that the moderators of r\/home removed/);

  // Approving the removed post makes it an ordinary post again.
  state.posts.get(originals[0]!)!.removed = false;
  assert.equal((await modAction('approvelink', originals[0]!, cases[0]!.remover)).status, 200);
  assert.equal(state.redis.has(`removed:${originals[0]}`), false);
  assert.equal(kept(originals[0]!).length, 3);
});

test('unless the option is ticked, a post that a moderator removes is erased like any removed post', async () => {
  // The settings as the app comes: nothing changed by the moderators.
  state.settings = {};
  const original = post({ title: 'A title removed by a person', url: 'https://i.redd.it/original.png' });
  await submit(original.event);
  state.posts.get(original.id)!.removed = true;
  await modAction('removelink', original.id, { name: 'modmary', accountType: 1 });
  assert.deepEqual(kept(original.id), []);
  assert.equal(state.redis.has(`removed:${original.id}`), false);

  await submit(post({ title: 'A title removed by a person', url: 'https://i.redd.it/again.png', author: 'bob' }).event);
  assert.deepEqual(state.removed, []);
});

test('approving a post the app removed deletes its removal comment', async () => {
  await submit(post({ title: 'Screenshot of the day from the app', url: 'https://i.redd.it/one.png' }).event);
  const repost = post({ title: 'Screenshot of the day from the app', url: 'https://i.redd.it/two.png' });
  await submit(repost.event);
  assert.deepEqual(state.removed, [repost.id]);
  // The app's own removal arrives as a moderator action and as a delete event, and takes nothing from the original.
  await modAction('removelink', repost.id, { name: 'repost-cooldown', accountType: 3 });
  await call('/internal/triggers/post-delete', { type: 'PostDelete', postId: repost.id, source: 3 });
  assert.deepEqual(state.deletedComments, []);

  Object.assign(state.posts.get(repost.id)!, { removed: false, removedByCategory: undefined });
  await modAction('approvelink', repost.id, { name: 'modmary', accountType: 1 });
  assert.deepEqual(state.deletedComments, ['t1_c1']);
  // Its own picture is recorded now; the title still belongs to the first post.
  assert.equal(kept(repost.id).length, 2);
  // Approved, the repost stays up: the same events sent again do not get it removed a second time.
  await submit(repost.event);
  assert.deepEqual(state.removed, [repost.id]);
});

test('a delete event erases the post when its author deleted it or Reddit took it down', async () => {
  // Reddit names who did it by number or by name: the author, or Reddit itself.
  for (const source of [1, 'USER', 2, 'ADMIN']) {
    const original = post({ title: `A title that will be deleted ${source}`, url: `https://i.redd.it/deleted${source}.png` });
    await submit(original.event);
    assert.equal(kept(original.id).length, 3);
    // Even when a moderator had removed the post before, and the app was remembering it.
    state.settings = { checkRemovedPosts: true };
    state.posts.get(original.id)!.removed = true;
    await modAction('removelink', original.id, { name: 'modmary', accountType: 1 });
    assert.equal(state.redis.has(`removed:${original.id}`), true);

    const event = { type: 'PostDelete', postId: original.id, source };
    assert.equal((await call('/internal/triggers/post-delete', event)).status, 200);
    assert.deepEqual(kept(original.id), [], String(source));
    assert.equal(state.sorted.get('recorded')!.has(original.id), false);
    // The same event sent again changes nothing.
    assert.equal((await call('/internal/triggers/post-delete', event)).status, 200);

    // Nothing that is left could be turned back into the post, or says who made it.
    const left = [...state.redis].filter(([key]) => key.endsWith(original.id)).map(([key, item]) => [key.split(':')[0], item.value]);
    assert.deepEqual(left.map(([kind]) => kind).sort(), ['gone', 'seen']);
    assert.equal(left.find(([kind]) => kind === 'gone')![1], '1');

    // So the same thing can be posted again.
    await submit(post({ title: `A title that will be deleted ${source}`, url: `https://i.redd.it/deleted${source}.png` }).event);
    assert.deepEqual(state.removed, []);
  }
});

test('a delete event that reports a removal, or does not say who did it, is not taken for a deletion', async () => {
  const deleteEvent = (id: string, source?: number | string) =>
    call('/internal/triggers/post-delete', { type: 'PostDelete', postId: id, ...(source === undefined ? {} : { source }) });

  // A moderator's removal: the moderator action that follows decides.
  for (const source of [3, 'MODERATOR']) {
    const removed = post({ title: `A title removed by a moderator ${source}`, url: `https://i.redd.it/removed${source}.png` });
    await submit(removed.event);
    state.posts.get(removed.id)!.removed = true;
    assert.equal((await deleteEvent(removed.id, source)).status, 200);
    assert.equal(kept(removed.id).length, 3, String(source));
  }

  // No word on who did it: the app looks at what became of the post.
  const stillRemoved = post({ title: 'A title on a post that is removed', url: 'https://i.redd.it/still-removed.png' });
  await submit(stillRemoved.event);
  state.posts.get(stillRemoved.id)!.removed = true;
  await deleteEvent(stillRemoved.id, 0);
  assert.equal(kept(stillRemoved.id).length, 3);

  const stillUp = post({ title: 'A title on a post that is still up', url: 'https://i.redd.it/still-up.png' });
  await submit(stillUp.event);
  await deleteEvent(stillUp.id);
  assert.equal(kept(stillUp.id).length, 3);

  const deleted = post({ title: 'A title on a post that was deleted', url: 'https://i.redd.it/was-deleted.png' });
  await submit(deleted.event);
  state.posts.get(deleted.id)!.authorName = '[deleted]';
  await deleteEvent(deleted.id, 0);
  assert.deepEqual(kept(deleted.id), []);

  // A post that cannot be read just now is not taken for deleted: a failed call says nothing about it.
  const unreadable = post({ title: 'A title on a post that cannot be read', url: 'https://i.redd.it/unreadable.png' });
  await submit(unreadable.event);
  state.posts.delete(unreadable.id);
  assert.equal((await deleteEvent(unreadable.id)).status, 200);
  assert.equal(kept(unreadable.id).length, 3);
});

test('a submit event that arrives after the delete event records nothing', async () => {
  const late = post({ title: 'A title on a post deleted at once', url: 'https://i.redd.it/late.png' });
  await call('/internal/triggers/post-delete', { type: 'PostDelete', postId: late.id, source: 1 });
  assert.equal((await submit(late.event)).status, 200);
  assert.deepEqual(kept(late.id), []);
  assert.equal([...state.redis.keys()].some((key) => key.startsWith('fp:')), false);
});

test('nothing the app stores names a person', async () => {
  const first = post({ title: 'Screenshot of the day from the app', url: 'https://i.redd.it/one.png', author: 'alice' });
  await submit(first.event);
  const second = post({ title: 'Screenshot of the day from the app', url: 'https://i.redd.it/two.png', author: 'bob' });
  await submit(second.event);
  assert.deepEqual(state.removed, [second.id]);
  const stored = JSON.stringify([...state.redis]);
  for (const personal of ['alice', 'bob', 't2_author', 'Screenshot', 'redd.it']) {
    assert.equal(stored.includes(personal), false, personal);
  }
});

test('an update that leaves the text as it was changes nothing', async () => {
  const link = 'https://example.com/product-page';
  const first = post({ title: 'First write-up about the product', text: `Details here: ${link}` });
  await submit(first.event);
  const before = JSON.stringify([...state.redis]);
  // An update event that carries no text, for a change that was not to the text.
  const unchanged = { ...first.event, post: { ...first.event.post, selftext: '' }, previousBody: '' };
  assert.equal((await call('/internal/triggers/post-update', { type: 'PostUpdate', ...unchanged })).status, 200);
  assert.equal(JSON.stringify([...state.redis]), before);
});

test('installing records recent posts and stops reading at the cooldown', async () => {
  const now = Date.now();
  const recent = post({ title: 'A title from ten days ago here', url: 'https://i.redd.it/ten.png', createdAt: now - 10 * DAY });
  post({ title: 'A title from forty days ago here', url: 'https://i.redd.it/forty.png', createdAt: now - 40 * DAY });
  post({ title: 'A title whose author deleted it', url: 'https://i.redd.it/gone.png', author: '[deleted]', createdAt: now - DAY });
  for (let n = 0; n < 250; n++) addPost({ id: `t3_old${n}`, createdAt: new Date(now - (50 + n) * DAY) });

  assert.equal((await call('/internal/triggers/app-install', { type: 'AppInstall' })).status, 200);
  assert.equal(state.listingPages, 1);

  const repeat = post({ title: 'A title from ten days ago here', url: 'https://i.redd.it/again.png' });
  await submit(repeat.event);
  assert.deepEqual(state.removed, [repeat.id]);
  assert.match(state.comments[0]!.text, new RegExp(`comments/${recent.id.slice(3)}/`));

  // Posts past the cooldown, and deleted ones, were not recorded.
  await submit(post({ title: 'A title from forty days ago here', url: 'https://i.redd.it/later.png' }).event);
  await submit(post({ title: 'A title whose author deleted it', url: 'https://i.redd.it/after.png' }).event);
  assert.deepEqual(state.removed, [repeat.id]);
});

test('updating the app erases posts that were removed without the app being told', async () => {
  const original = post({ title: 'A title on a post removed quietly', url: 'https://i.redd.it/quiet.png' });
  await submit(original.event);
  const other = post({ title: 'A title on a post that is still up', url: 'https://i.redd.it/up.png' });
  await submit(other.event);
  // Removed by a filter, with no event.
  state.posts.get(original.id)!.removedByCategory = 'reddit';

  assert.equal((await call('/internal/triggers/app-upgrade', { type: 'AppUpgrade' })).status, 200);
  assert.deepEqual(kept(original.id), []);
  assert.equal(kept(other.id).length, 3);
});

test('the daily check erases removed posts, keeps the others, and waits when the settings cannot be read', async () => {
  const original = post({ title: 'A title on a post removed quietly', url: 'https://i.redd.it/quiet.png' });
  await submit(original.event);
  const other = post({ title: 'A title on a post that is still up', url: 'https://i.redd.it/up.png' });
  await submit(other.event);
  state.posts.get(original.id)!.removedByCategory = 'automod_filtered';

  // On settings it would have to guess, it changes nothing and leaves the work for the next day.
  state.settingsFail = true;
  const before = JSON.stringify([...state.redis]);
  assert.equal((await call('/internal/scheduler/daily-check', { name: 'daily-check' })).status, 500);
  assert.equal(JSON.stringify([...state.redis]), before);

  state.settingsFail = false;
  const answer = await call('/internal/scheduler/daily-check', { name: 'daily-check' });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { status: 'ok' });
  assert.deepEqual(kept(original.id), []);
  assert.equal(kept(other.id).length, 3);
});

test('the daily check erases a post that was deleted without the app being told', async () => {
  const hour = 60 * 60 * 1000;
  const deleted = post({ title: 'A title on a post deleted quietly', url: 'https://i.redd.it/quiet.png', createdAt: Date.now() - 2 * hour });
  await submit(deleted.event);
  const older = post({ title: 'A title on an older post still up', url: 'https://i.redd.it/older.png', createdAt: Date.now() - 3 * hour });
  await submit(older.event);
  const fresh = post({ title: 'A title on a post made just now', url: 'https://i.redd.it/fresh.png' });
  await submit(fresh.event);
  assert.equal(state.sorted.get('recorded')!.size, 3);
  // Reddit no longer lists the first one, and does not list the newest one yet.
  state.posts.delete(deleted.id);
  state.posts.delete(fresh.id);

  assert.equal((await call('/internal/scheduler/daily-check', { name: 'daily-check' })).status, 200);
  assert.deepEqual(kept(deleted.id), []);
  assert.equal(kept(older.id).length, 3);
  assert.equal(kept(fresh.id).length, 3);
  assert.deepEqual([...state.sorted.get('recorded')!.keys()].sort(), [older.id, fresh.id].sort());
});

test('the daily check concludes nothing about posts older than Reddit lists', async () => {
  const now = Date.now();
  const old = post({ title: 'A title on a post from five days ago', url: 'https://i.redd.it/five.png', createdAt: now - 5 * DAY });
  await submit(old.event);
  // A busy subreddit: a thousand newer posts, so Reddit's list of 1000 does not reach the old one.
  for (let n = 0; n < 1000; n++) addPost({ id: `t3_busy${n}`, createdAt: new Date(now - DAY - n * 60_000) });

  assert.equal((await call('/internal/scheduler/daily-check', { name: 'daily-check' })).status, 200);
  assert.equal(kept(old.id).length, 3);
  assert.equal(state.sorted.get('recorded')!.size, 1001);
});

test('a post that a moderator removed keeps counting after its author deletes it, as Reddit sends no event', async () => {
  const hour = 60 * 60 * 1000;
  const original = post({ title: 'A title removed by a person', url: 'https://i.redd.it/original.png', createdAt: Date.now() - 2 * hour });
  await submit(original.event);
  const older = post({ title: 'A title on an older post still up', url: 'https://i.redd.it/older.png', createdAt: Date.now() - 3 * hour });
  await submit(older.event);
  state.settings = { checkRemovedPosts: true };
  state.posts.get(original.id)!.removed = true;
  await modAction('removelink', original.id, { name: 'modmary', accountType: 1 });

  // Reddit lists it as removed, and a moderator removed it: the daily check leaves it.
  assert.equal((await call('/internal/scheduler/daily-check', { name: 'daily-check' })).status, 200);
  assert.equal(kept(original.id).length, 3);
  assert.equal(state.redis.has(`removed:${original.id}`), true);

  // Its author deletes it. Reddit sends no event for that; the post is just
  // gone from the list, and can no longer be read. The app does not go looking.
  state.posts.delete(original.id);
  assert.equal((await call('/internal/scheduler/daily-check', { name: 'daily-check' })).status, 200);
  assert.equal(kept(original.id).length, 3);
  const repost = post({ title: 'A title removed by a person', url: 'https://i.redd.it/again.png', author: 'bob' });
  await submit(repost.event);
  assert.deepEqual(state.removed, [repost.id]);
  assert.match(state.comments[0]!.text, /that the moderators of r\/home removed/);

  // If Reddit did send a delete event, the post would be erased at once.
  const told = post({ title: 'A second title removed by a person', url: 'https://i.redd.it/told.png', createdAt: Date.now() - 2 * hour });
  await submit(told.event);
  state.posts.get(told.id)!.removed = true;
  await modAction('removelink', told.id, { name: 'modmary', accountType: 1 });
  await call('/internal/triggers/post-delete', { type: 'PostDelete', postId: told.id, source: 1 });
  assert.deepEqual(kept(told.id), []);

  // And once the moderators untick the option, the next daily check erases it.
  state.settings = {};
  assert.equal((await call('/internal/scheduler/daily-check', { name: 'daily-check' })).status, 200);
  assert.deepEqual(kept(original.id), []);
  assert.equal(state.redis.has(`removed:${original.id}`), false);
  assert.equal(kept(older.id).length, 3);
});

test('an update while the settings cannot be read does not erase the posts that a moderator removed', async () => {
  const hour = 60 * 60 * 1000;
  const original = post({ title: 'A title removed by a person', url: 'https://i.redd.it/original.png', createdAt: Date.now() - 2 * hour });
  await submit(original.event);
  const filtered = post({ title: 'A title removed by a filter', url: 'https://i.redd.it/filtered.png', createdAt: Date.now() - 2 * hour });
  await submit(filtered.event);
  state.settings = { checkRemovedPosts: true };
  state.posts.get(original.id)!.removed = true;
  await modAction('removelink', original.id, { name: 'modmary', accountType: 1 });
  state.posts.get(filtered.id)!.removedByCategory = 'reddit';

  // The app cannot tell whether the option is on, so it erases nothing that depends on it.
  state.settingsFail = true;
  assert.equal((await call('/internal/triggers/app-upgrade', { type: 'AppUpgrade' })).status, 200);
  assert.equal(kept(original.id).length, 3);
  assert.equal(state.redis.has(`removed:${original.id}`), true);
  // A post removed by a filter is erased either way.
  assert.deepEqual(kept(filtered.id), []);
});

test('the erase menu item asks first, and erases everything only when the box is ticked', async () => {
  // One of each thing the app stores: a recorded post, a repost it removed and commented on, a post that a moderator removed.
  await submit(post({ title: 'Screenshot of the day from the app', url: 'https://i.redd.it/one.png' }).event);
  await submit(post({ title: 'Screenshot of the day from the app', url: 'https://i.redd.it/two.png', author: 'bob' }).event);
  const byMod = post({ title: 'A title removed by a person', url: 'https://i.redd.it/original.png' });
  await submit(byMod.event);
  state.settings = { checkRemovedPosts: true };
  state.posts.get(byMod.id)!.removed = true;
  await modAction('removelink', byMod.id, { name: 'modmary', accountType: 1 });

  const asked = await call('/internal/menu/erase', {});
  assert.equal(asked.status, 200);
  const shown = asked.body.showForm as {
    name: string;
    form: { title: string; description: string; fields: Array<{ type: string; name: string; defaultValue: boolean }> };
  };
  assert.equal(shown.name, 'eraseForm');
  assert.deepEqual(shown.form.fields.map((field) => [field.type, field.name, field.defaultValue]), [['boolean', 'confirm', false]]);
  // The moderator is warned before anything happens, in the title and at the start of the text.
  assert.match(shown.form.title, /^WARNING/);
  assert.match(shown.form.description, /^WARNING: this cannot be undone\./);
  assert.ok(shown.form.description.includes('r/home'));

  // Asking erased nothing, and neither does an answer without the tick.
  const stored = state.redis.size;
  assert.ok(stored > 8);
  for (const answer of [{}, { confirm: false }, { confirm: 'true' }]) {
    const refused = await call('/internal/form/erase', answer);
    assert.deepEqual(refused.body, { showToast: 'Nothing was erased: the box was not ticked.' });
  }
  assert.equal(state.redis.size, stored);

  // Every key, and the list of recorded posts.
  const erased = await call('/internal/form/erase', { confirm: true });
  assert.deepEqual(erased.body, {
    showToast: { text: `Repost Cooldown erased everything it had stored (${stored + 1} entries).`, appearance: 'success' },
  });
  assert.equal(state.redis.size, 0);
  assert.equal(state.sorted.size, 0);

  // The app is still on: a post that comes in afterwards is recorded.
  const next = post({ title: 'Screenshot of the day from the app', url: 'https://i.redd.it/three.png' });
  await submit(next.event);
  assert.equal(kept(next.id).length, 3);
  assert.equal(state.removed.length, 1);
});

test('every endpoint named in devvit.json is served', async () => {
  const config = JSON.parse(await readFile(new URL('../devvit.json', import.meta.url), 'utf8')) as {
    triggers: Record<string, string>;
    scheduler: { tasks: Record<string, { endpoint: string; cron: string }> };
    menu: { items: Array<{ endpoint: string; label: string; description: string; forUserType: string; location: string }> };
    forms: Record<string, string>;
    settings: { subreddit: Record<string, { defaultValue: unknown }> };
  };
  // The form the erase menu item shows must be one that devvit.json names.
  assert.deepEqual(config.forms, { eraseForm: '/internal/form/erase' });
  // Both menu items are for moderators, on the subreddit, and the erase item carries its warning.
  assert.deepEqual(config.menu.items.map((item) => [item.label, item.forUserType, item.location]), [
    ['Repost Cooldown: rescan recent posts', 'moderator', 'subreddit'],
    ['Repost Cooldown: erase stored data', 'moderator', 'subreddit'],
  ]);
  assert.match(config.menu.items[1]!.description, /^WARNING/);
  // What the settings page shows before a moderator changes anything is what the app uses.
  const defaults = Object.fromEntries(Object.entries(config.settings.subreddit).map(([name, field]) => [name, field.defaultValue]));
  assert.equal(defaults.exemptModerators, true);
  assert.equal(defaults.checkRemovedPosts, false);
  assert.deepEqual(parseSettings(defaults), parseSettings(undefined));
  const endpoints = [
    ...Object.values(config.triggers),
    ...Object.values(config.scheduler.tasks).map((task) => task.endpoint),
    ...config.menu.items.map((item) => item.endpoint),
    ...Object.values(config.forms),
  ];
  assert.equal(endpoints.length, 10);
  for (const endpoint of endpoints) {
    assert.equal((await call(endpoint, {})).status, 200, endpoint);
  }
});

test('the rescan menu item answers with a count, even when the settings cannot be read', async () => {
  post({ title: 'One recent post to be counted', url: 'https://i.redd.it/count.png' });
  state.settingsFail = true;
  const answer = await call('/internal/menu/rescan', {});
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, {
    showToast: { text: 'Repost Cooldown now knows 1 recent posts.', appearance: 'success' },
  });
});

test('events without a post, and unknown paths, change nothing', async () => {
  assert.equal((await submit({})).status, 200);
  assert.equal((await call('/internal/triggers/post-update', { type: 'PostUpdate' })).status, 200);
  assert.equal((await call('/internal/triggers/post-delete', { type: 'PostDelete', postId: 't3_unknown', source: 1 })).status, 200);
  assert.equal((await call('/internal/triggers/mod-action', { type: 'ModAction', action: 'removelink' })).status, 200);
  const stranger = { id: 't2_moderator', name: 'modmary', accountType: 1 };
  const unknown = { type: 'ModAction', action: 'removelink', targetPost: { id: 't3_unknown' }, moderator: stranger };
  assert.equal((await call('/internal/triggers/mod-action', unknown)).status, 200);
  assert.equal((await call('/internal/nothing-here')).status, 404);
  assert.deepEqual(state.removed, []);
  // All that is stored is that the unknown post is gone.
  assert.deepEqual([...state.redis.keys()], ['gone:t3_unknown']);
});
