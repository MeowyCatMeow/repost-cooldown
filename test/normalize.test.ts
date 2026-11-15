import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeTitle, normalizeUrl, redditPostIdFromUrl, titleWeight, toPostId } from '../src/core/normalize.ts';

test('titles ignore case, punctuation, emoji and spacing', () => {
  assert.equal(normalizeTitle('  OpenAI releases GPT-6!!! 🚀 '), normalizeTitle('openai releases gpt 6'));
  assert.equal(normalizeTitle('Tom &amp; Jerry'), 'tom jerry');
  assert.notEqual(normalizeTitle('Claude beats GPT'), normalizeTitle('GPT beats Claude'));
  assert.equal(titleWeight(normalizeTitle('Help!')), 4);
});

test('non-Latin titles are kept', () => {
  assert.equal(normalizeTitle('新しい モデル！'), '新しい モデル');
});

test('links ignore protocol, www, tracking, fragment and trailing slash', () => {
  const a = normalizeUrl('https://www.example.com/news/story/?utm_source=x&id=5&fbclid=abc#top');
  const b = normalizeUrl('http://example.com/news/story?id=5');
  assert.equal(a, b);
  assert.equal(a, 'example.com/news/story?id=5');
  assert.notEqual(normalizeUrl('https://example.com/a?id=5'), normalizeUrl('https://example.com/a?id=6'));
  assert.equal(normalizeUrl('https://example.com/a?b=1&amp;a=2'), 'example.com/a?a=2&b=1');
});

test('YouTube and X links have one spelling', () => {
  const id = 'dQw4w9WgXcQ';
  const forms = [
    `https://youtu.be/${id}?si=abc`,
    `https://www.youtube.com/watch?v=${id}&t=42s`,
    `https://m.youtube.com/watch?feature=share&v=${id}`,
    `https://youtube.com/shorts/${id}`,
  ];
  for (const form of forms) assert.equal(normalizeUrl(form), `youtube.com/watch?v=${id}`);
  assert.equal(normalizeUrl('https://twitter.com/Sama/status/123?s=20'), normalizeUrl('https://x.com/sama/status/123'));
});

test('Reddit post links resolve to the post id', () => {
  const forms = [
    'https://www.reddit.com/r/ai/comments/1abc2d/some_title/',
    'https://old.reddit.com/r/ai/comments/1abc2d/',
    '/r/ai/comments/1abc2d/some_title/',
    'https://redd.it/1abc2d',
    'https://www.reddit.com/gallery/1abc2d',
    'https://reddit.com/comments/1abc2d',
  ];
  for (const form of forms) {
    assert.equal(redditPostIdFromUrl(form), 't3_1abc2d', form);
    assert.equal(normalizeUrl(form), 'reddit.com/comments/1abc2d', form);
  }
});

test('links that are not Reddit posts have no post id', () => {
  assert.equal(redditPostIdFromUrl('https://www.reddit.com/r/ai/comments/1abc2d/title/k9zzz1/'), undefined);
  assert.equal(redditPostIdFromUrl('https://www.reddit.com/r/ai/'), undefined);
  assert.equal(redditPostIdFromUrl('https://i.redd.it/abcdef.jpg'), undefined);
  assert.equal(redditPostIdFromUrl('https://example.com/comments/1abc2d'), undefined);
  assert.equal(redditPostIdFromUrl(''), undefined);
});

test('unusable links are ignored', () => {
  assert.equal(normalizeUrl(''), undefined);
  assert.equal(normalizeUrl('not a url'), undefined);
  assert.equal(normalizeUrl('mailto:someone@example.com'), undefined);
});

test('post ids get their prefix', () => {
  assert.equal(toPostId('1abc2d'), 't3_1abc2d');
  assert.equal(toPostId('t3_1abc2d'), 't3_1abc2d');
  assert.equal(toPostId(''), undefined);
  assert.equal(toPostId(undefined), undefined);
});
