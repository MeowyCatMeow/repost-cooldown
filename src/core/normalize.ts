/**
 * Pure helpers that turn a post's title and link into comparable forms, so
 * that two posts sharing "the same" title or link produce the same string.
 */

const REDDIT_HOSTS = new Set(['reddit.com', 'redd.it']);
const YOUTUBE_HOSTS = new Set(['youtube.com', 'music.youtube.com', 'youtube-nocookie.com']);
const TWITTER_HOSTS = new Set(['twitter.com', 'x.com', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com']);

/** Query parameters that track the sharer and never change what a link shows. */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'igsh',
  'si',
  'ref',
  'ref_src',
  'ref_url',
  'share_id',
]);

/** Share parameters that mean nothing on one site but can select a page on another. */
const YOUTUBE_ONLY_PARAMS = new Set(['feature', 'app']);
const TWITTER_ONLY_PARAMS = new Set(['s', 't', 'src']);

/**
 * Undoes HTML escaping. Reddit escapes text in some places and not in others,
 * so "&amp;" goes first: text that was escaped twice then compares equal too.
 */
function decodeEntities(text: string): string {
  return (
    text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, ' ')
      // Numbered forms, such as the "&#x200B;" (an invisible space) that
      // Reddit's editor writes between paragraphs.
      .replace(/&#(x[0-9a-f]{1,6}|[0-9]{1,7});/gi, (whole, code: string) => {
        const point = /^x/i.test(code) ? parseInt(code.slice(1), 16) : parseInt(code, 10);
        const valid = point > 0 && point <= 0x10ffff && (point < 0xd800 || point > 0xdfff);
        return valid ? String.fromCodePoint(point) : whole;
      })
  );
}

/** `"abc"` or `"t3_abc"` to `"t3_abc"`; empty or missing to `undefined`. */
export function toPostId(raw: string | undefined | null): string | undefined {
  const id = (raw ?? '').trim().toLowerCase();
  if (!id) return undefined;
  return id.startsWith('t3_') ? id : `t3_${id}`;
}

/** Lowercased title with punctuation, emoji and extra spacing removed. */
export function normalizeTitle(title: string): string {
  return (
    decodeEntities(title)
      .normalize('NFKC')
      .toLowerCase()
      // Marks that only pick a symbol's appearance or draw a box around it.
      .replace(/[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]|\p{Me}/gu, '')
      // Keep letters, digits and the marks that are part of a letter: the
      // vowel signs and accents of Hindi, Thai, Arabic and other scripts.
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
      // A mark with no letter before it belonged to a symbol that is now gone.
      .replace(/(^| )\p{M}+/gu, '$1')
      .replace(/ +/g, ' ')
      .trim()
  );
}

/** How many letters and digits a normalized title has. */
export function titleWeight(normalizedTitle: string): number {
  return normalizedTitle.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

function parseUrl(raw: string): URL | undefined {
  let text = decodeEntities(raw ?? '').trim();
  if (!text) return undefined;
  // Reddit reports text posts and some crossposts as a bare permalink path.
  if (text.startsWith('/')) text = `https://www.reddit.com${text}`;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

function bareHost(url: URL): string {
  const host = url.hostname.toLowerCase();
  // Reddit has many front ends (old., new., np., sh., ...) for the same pages.
  if (/(^|\.)reddit\.com$/.test(host)) return 'reddit.com';
  return (
    host
      // "www.", "m." and the like name the same site, unless what follows is
      // not a site on its own: "mobile.de" and "amp.dev" are left whole.
      .replace(/^(www|m|mobile|amp)\.(?=[^.]+\.)/, '')
      // Wikipedia and its sister sites put the "m." in the middle.
      .replace(/\.m\.(?=[^.]+\.[^.]+$)/, '.')
  );
}

function redditPostIdFromParts(host: string, segments: string[]): string | undefined {
  if (!REDDIT_HOSTS.has(host)) return undefined;
  if (host === 'redd.it') {
    return segments.length === 1 ? toPostId(segments[0]) : undefined;
  }
  // /comments/<id>[/<slug>], /r/<sub>/comments/<id>[/<slug>], /gallery/<id>
  const at = segments.indexOf('comments');
  if (at === 0 || (at === 2 && (segments[0] === 'r' || segments[0] === 'u' || segments[0] === 'user'))) {
    // A further segment after the slug is a comment id: a link to a comment, not to the post.
    if (segments.length > at + 3) return undefined;
    return toPostId(segments[at + 1]);
  }
  if (segments[0] === 'gallery' && segments.length === 2) return toPostId(segments[1]);
  return undefined;
}

function segmentsOf(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean);
}

/**
 * The post a Reddit URL points at (`"t3_abc"`), or `undefined` when the URL
 * is not a link to a Reddit post.
 */
export function redditPostIdFromUrl(raw: string): string | undefined {
  const url = parseUrl(raw);
  if (!url) return undefined;
  return redditPostIdFromParts(bareHost(url), segmentsOf(url));
}

function youtubeVideoId(host: string, url: URL, segments: string[]): string | undefined {
  if (host === 'youtu.be') return segments[0];
  if (!YOUTUBE_HOSTS.has(host)) return undefined;
  if (segments[0] === 'watch') return url.searchParams.get('v') ?? undefined;
  if (segments[0] && ['shorts', 'live', 'embed', 'v'].includes(segments[0])) {
    // "embed/videoseries" is a playlist player; its "list" parameter says which.
    return segments[1] === 'videoseries' ? undefined : segments[1];
  }
  return undefined;
}

/**
 * The part of an address after "#", when it selects what the page shows.
 * "#section", "#L10-L20" and "#:~:text=..." only point into a page and are
 * dropped; "#/guide", "#!topic/x" and "#code/abc" are how some sites address
 * the page itself, and two of those are different links.
 */
function pageState(hash: string): string {
  if (hash.startsWith('#:~:') || /^#[\p{L}\p{N}_.~%-]*$/u.test(hash)) return '';
  return /^#!?\/?$/.test(hash) ? '' : hash;
}

/**
 * A comparable form of a link: no protocol, `www.`, tracking parameters,
 * page anchor or trailing slash, and one spelling for the sites that have
 * several (Reddit, YouTube, X/Twitter). `undefined` when there is no usable link.
 */
export function normalizeUrl(raw: string): string | undefined {
  const url = parseUrl(raw);
  if (!url) return undefined;
  const host = bareHost(url);
  const segments = segmentsOf(url);

  const postId = redditPostIdFromParts(host, segments);
  if (postId) return `reddit.com/comments/${postId.slice(3)}`;

  const videoId = youtubeVideoId(host, url, segments);
  if (videoId) return `youtube.com/watch?v=${videoId}`;

  // X/Twitter has several names for one site, and ignores capitals in its addresses.
  const twitter = TWITTER_HOSTS.has(host);
  const site = twitter ? 'x.com' : `${host}${url.port ? `:${url.port}` : ''}`;
  const path = twitter ? segments.join('/').toLowerCase() : segments.join('/');
  if (twitter) {
    // A post there is known by its number alone, whoever's name is in front of it.
    const parts = path.split('/');
    const status = parts[parts.indexOf('status') + 1];
    if (parts.includes('status') && status) return `x.com/status/${status}`;
  }

  const siteParams = twitter ? TWITTER_ONLY_PARAMS : YOUTUBE_HOSTS.has(host) ? YOUTUBE_ONLY_PARAMS : undefined;
  const params = [...url.searchParams.entries()]
    .filter(([name]) => {
      const key = name.toLowerCase();
      return !key.startsWith('utm_') && !TRACKING_PARAMS.has(key) && !siteParams?.has(key);
    })
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)))
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${site}${path ? `/${path}` : ''}${params ? `?${params}` : ''}${pageState(url.hash)}`;
}

/**
 * True when a normalized link is only a site's front page, such as
 * `youtube.com`. Front pages say nothing about what was shared.
 */
export function isHomepage(normalizedUrl: string): boolean {
  return !/[/?#]/.test(normalizedUrl);
}

/**
 * True when a normalized link points at Reddit itself: a post, a subreddit,
 * a user, or a picture or video that Reddit hosts ("i.redd.it", "v.redd.it").
 */
export function isRedditLink(normalizedUrl: string): boolean {
  const host = normalizedUrl.split(/[/?#:]/, 1)[0] ?? '';
  return host === 'reddit.com' || host === 'redd.it' || host.endsWith('.redd.it');
}

/** Characters that end a sentence or belong to Markdown, not to the address before them. */
const TRAILING = '.,;:!?*_~|';

/** The web addresses written in a post's text, in order, as written. */
export function linksInText(text: string): string[] {
  // An address ends at a space, a quote or backtick, a bracket, or an invisible space.
  const found = decodeEntities(text ?? '').match(/https?:\/\/[^\s<>"'`[\]\u{200B}-\u{200D}\u{2060}]+/giu) ?? [];
  const links = new Set<string>();
  for (const raw of found) {
    // Reddit's Markdown escapes some characters in addresses with a backslash.
    const link = raw.replaceAll('\\', '');
    // Drop what belongs to the sentence or the Markdown around the address:
    // closing punctuation, and each ")" that has no "(" inside the address.
    let unmatched = 0;
    for (const char of link) unmatched += char === ')' ? 1 : char === '(' ? -1 : 0;
    let end = link.length;
    for (; end > 0; end--) {
      const last = link[end - 1]!;
      if (last === ')' && unmatched > 0) unmatched--;
      else if (!TRAILING.includes(last)) break;
    }
    if (end > 0) links.add(link.slice(0, end));
  }
  return [...links];
}
