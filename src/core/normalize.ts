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
  'feature',
  'app',
]);

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** `"abc"` or `"t3_abc"` to `"t3_abc"`; empty or missing to `undefined`. */
export function toPostId(raw: string | undefined | null): string | undefined {
  const id = (raw ?? '').trim().toLowerCase();
  if (!id) return undefined;
  return id.startsWith('t3_') ? id : `t3_${id}`;
}

/** Lowercased title with punctuation, emoji and extra spacing removed. */
export function normalizeTitle(title: string): string {
  return decodeEntities(title)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** How many letters and digits a normalized title has. */
export function titleWeight(normalizedTitle: string): number {
  return normalizedTitle.replace(/ /g, '').length;
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
  let host = url.hostname.toLowerCase();
  // Reddit has many front ends (old., new., np., sh., ...) for the same pages.
  if (/(^|\.)reddit\.com$/.test(host)) return 'reddit.com';
  host = host.replace(/^(www|m|mobile|amp)\./, '');
  return host;
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
  if (segments[0] && ['shorts', 'live', 'embed', 'v'].includes(segments[0])) return segments[1];
  return undefined;
}

/**
 * A comparable form of a link: no protocol, `www.`, tracking parameters,
 * fragment or trailing slash, and one spelling for the sites that have
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

  if (TWITTER_HOSTS.has(host)) {
    return segments.length ? `x.com/${segments.join('/').toLowerCase()}` : 'x.com';
  }

  const params = [...url.searchParams.entries()]
    .filter(([name]) => !name.toLowerCase().startsWith('utm_') && !TRACKING_PARAMS.has(name.toLowerCase()))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)))
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
  const port = url.port ? `:${url.port}` : '';
  const path = segments.length ? `/${segments.join('/')}` : '';
  return `${host}${port}${path}${params ? `?${params}` : ''}`;
}

/**
 * True when a normalized link is only a site's front page, such as
 * `youtube.com`. Front pages say nothing about what was shared.
 */
export function isHomepage(normalizedUrl: string): boolean {
  return !normalizedUrl.includes('/') && !normalizedUrl.includes('?');
}

/** True when a normalized link points at Reddit itself (a post, a subreddit, a user). */
export function isRedditLink(normalizedUrl: string): boolean {
  return normalizedUrl === 'reddit.com' || normalizedUrl.startsWith('reddit.com/') || normalizedUrl.startsWith('redd.it/');
}

/** The web addresses written in a post's text, in order, as written. */
export function linksInText(text: string): string[] {
  const found = decodeEntities(text ?? '').match(/https?:\/\/[^\s<>"'[\]]+/gi) ?? [];
  const links: string[] = [];
  for (const raw of found) {
    // Reddit's Markdown escapes some characters in addresses with a backslash.
    let link = raw.replaceAll('\\', '');
    // Drop what belongs to the sentence or the Markdown around the address.
    for (;;) {
      const last = link.at(-1) ?? '';
      const unbalanced = last === ')' && link.split(')').length > link.split('(').length;
      if ('.,;:!?*_~'.includes(last) || unbalanced) link = link.slice(0, -1);
      else break;
    }
    if (link && !links.includes(link)) links.push(link);
  }
  return links;
}
