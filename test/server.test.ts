/**
 * Runs the real entry point, src/server/index.ts, with test/fake-devvit.ts in
 * place of Devvit, and calls its endpoints over HTTP as Reddit does.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { registerHooks } from 'node:module';
import type { AddressInfo } from 'node:net';
import { after, beforeEach, test } from 'node:test';

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

/** A moderator action as Reddit reports it. Account type 1 is a person, 3 is an app. */
const modAction = (action: string, id: string, moderator: { name: string; accountType: number }) =>
  call('/internal/triggers/mod-action', {
    type: 'ModAction',
    action,
    targetPost: { id },
    moderator: { id: 't2_moderator', ...moderator },
  });

test('a post removed by a person still counts; one removed by an app or AutoModerator does not', async () => {
  const cases = [
    { title: 'A title removed by a person', remover: { name: 'modmary', accountType: 1 } },
    { title: 'A title removed by another app', remover: { name: 'flood-assistant', accountType: 3 } },
    { title: 'A title removed by AutoModerator', remover: { name: 'AutoModerator', accountType: 1 } },
  ];
  const originals: string[] = [];
  for (const [index, { title, remover }] of cases.entries()) {
    const original = post({ title, url: `https://i.redd.it/original${index}.png` });
    await submit(original.event);
    state.posts.get(original.id)!.removed = true;
    assert.equal((await modAction('removelink', original.id, remover)).status, 200);
    originals.push(original.id);
  }

  const reposts: string[] = [];
  for (const [index, { title }] of cases.entries()) {
    const repost = post({ title, url: `https://i.redd.it/repost${index}.png`, author: 'bob' });
    await submit(repost.event);
    reposts.push(repost.id);
  }
  assert.deepEqual(state.removed, [reposts[0]]);
  assert.match(state.comments[0]!.text, /that the moderators of r\/home removed/);

  // Approving the removed post makes it an ordinary post again.
  state.posts.get(originals[0]!)!.removed = false;
  assert.equal(state.redis.has(`removed:${originals[0]}`), true);
  await modAction('approvelink', originals[0]!, cases[0]!.remover);
  assert.equal(state.redis.has(`removed:${originals[0]}`), false);
});

test('only the author deleting a post frees it at once', async () => {
  const original = post({ title: 'A title that will be deleted', url: 'https://i.redd.it/deleted.png' });
  await submit(original.event);
  const record = `post:${original.id}`;
  // Reddit reports a removal by a moderator as a delete too; that frees nothing.
  await call('/internal/triggers/post-delete', { type: 'PostDelete', postId: original.id, source: 3 });
  assert.equal(state.redis.has(record), true);
  await call('/internal/triggers/post-delete', { type: 'PostDelete', postId: original.id, source: 1 });
  assert.equal(state.redis.has(record), false);
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
  assert.equal(state.redis.size, 0);
});
