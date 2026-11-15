import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isHomepage,
  isRedditLink,
  linksInText,
  normalizeTitle,
  normalizeUrl,
  redditPostIdFromUrl,
  titleWeight,
  toPostId,
} from '../src/core/normalize.ts';

test('titles ignore case, punctuation, emoji and spacing', () => {
  assert.equal(normalizeTitle('  OpenAI releases GPT-6!!! 🚀 '), normalizeTitle('openai releases gpt 6'));
  assert.equal(normalizeTitle('Tom &amp; Jerry'), 'tom jerry');
  assert.notEqual(normalizeTitle('Claude beats GPT'), normalizeTitle('GPT beats Claude'));
  assert.equal(titleWeight(normalizeTitle('Help!')), 4);
});

test('non-Latin titles are kept', () => {
  assert.equal(normalizeTitle('新しい モデル！'), '新しい モデル');
});

test('letters keep their vowel signs and accents', () => {
  assert.notEqual(normalizeTitle('कमल'), normalizeTitle('कमला'));
  assert.equal(titleWeight(normalizeTitle('कमला')), 3);
  assert.equal(normalizeTitle('สวัสดีครับ!'), 'สวัสดีครับ');
  assert.notEqual(normalizeTitle('كَتَبَ'), normalizeTitle('كُتِبَ'));
  assert.equal(normalizeTitle('Café'), normalizeTitle('Cafe\u{301}'));
  // Marks that belonged to a removed symbol go with it: a heart and two keycaps.
  const symbols = 'I \u{2764}\u{FE0F} this 1\u{FE0F}\u{20E3} model #\u{FE0F}\u{20E3}';
  assert.equal(normalizeTitle(symbols), 'i this 1 model');
});

test('escaped characters are decoded before comparing', () => {
  assert.equal(normalizeTitle('First part.\n\n&#x200B;\n\nSecond part.'), 'first part second part');
  assert.equal(normalizeTitle('one&nbsp;two &amp;#39;three&#39;'), 'one two three');
  assert.equal(normalizeTitle('Tom &amp;amp; Jerry &#xD800; &#0;'), 'tom amp jerry xd800 0');
});

test('a parameter or fragment that selects the page is part of the link', () => {
  assert.notEqual(normalizeUrl('https://example.com/get?app=notes'), normalizeUrl('https://example.com/get?app=mail'));
  assert.equal(
    normalizeUrl('https://www.youtube.com/playlist?list=PL1&feature=shared&app=desktop'),
    'youtube.com/playlist?list=PL1'
  );
  assert.equal(normalizeUrl('https://example.com/docs/#/guide/install'), 'example.com/docs#/guide/install');
  assert.notEqual(normalizeUrl('https://example.com/docs/#/guide/install'), normalizeUrl('https://example.com/docs/#/guide/usage'));
  assert.equal(normalizeUrl('https://example.com/docs#install'), 'example.com/docs');
  assert.equal(isHomepage(normalizeUrl('https://example.com/#/')!), true);
  assert.equal(isHomepage(normalizeUrl('https://example.com/#/guide')!), false);
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

test('front pages are recognised', () => {
  for (const url of ['https://www.youtube.com/', 'http://youtube.com', 'https://x.com/', 'https://example.com/?utm_source=a#top']) {
    assert.equal(isHomepage(normalizeUrl(url)!), true, url);
  }
  for (const url of ['https://www.youtube.com/watch?v=45RTkHgR3Gc', 'https://example.com/shop', 'https://example.com/?id=5']) {
    assert.equal(isHomepage(normalizeUrl(url)!), false, url);
  }
});

test('Reddit links are recognised', () => {
  assert.equal(isRedditLink(normalizeUrl('https://old.reddit.com/r/ai/comments/1abc2d/x/')!), true);
  assert.equal(isRedditLink(normalizeUrl('https://www.reddit.com/r/ai/')!), true);
  assert.equal(isRedditLink(normalizeUrl('https://redditstatus.com/incidents/1')!), false);
});

test('links are found in post text', () => {
  const text = [
    'Check [this video](https://youtu.be/45RTkHgR3Gc) and https://example.com/a\\_b_c.',
    'Wiki: https://en.wikipedia.org/wiki/Claude_(language_model), also (https://example.com/paren).',
    'Twice: https://example.com/a_b_c and <https://example.com/angle>',
    'Not links: www.example.com, ftp://example.com/file, example.com/page',
  ].join('\n');
  assert.deepEqual(linksInText(text), [
    'https://youtu.be/45RTkHgR3Gc',
    'https://example.com/a_b_c',
    'https://en.wikipedia.org/wiki/Claude_(language_model)',
    'https://example.com/paren',
    'https://example.com/angle',
  ]);
  assert.deepEqual(linksInText(''), []);
});

test('links end at Markdown marks and invisible characters', () => {
  const text = 'Run `https://example.com/a` or |https://example.com/b| or https://example.com/c\u{200B}. Or **https://example.com/d**';
  assert.deepEqual(linksInText(text), [
    'https://example.com/a',
    'https://example.com/b',
    'https://example.com/c',
    'https://example.com/d',
  ]);
});

test('a link followed by a very long run of brackets is handled quickly', () => {
  const started = performance.now();
  assert.deepEqual(linksInText(`https://example.com/a${')'.repeat(39000)}`), ['https://example.com/a']);
  assert.ok(performance.now() - started < 1000);
});

test('post ids get their prefix', () => {
  assert.equal(toPostId('1abc2d'), 't3_1abc2d');
  assert.equal(toPostId('t3_1abc2d'), 't3_1abc2d');
  assert.equal(toPostId(''), undefined);
  assert.equal(toPostId(undefined), undefined);
});
