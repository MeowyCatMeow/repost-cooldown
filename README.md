# Repost Cooldown

Repost Cooldown keeps your sub from filling up with the same posts.

When someone crossposts a post from your own subreddit, the app checks how old the original is. If it was posted less than 30 days ago, the crosspost is removed.

The app also catches regular reposts: if a new post shares the same link, title or text as a post made in your sub within the last 30 days, it's removed.

Older posts are fine to share again once the cooldown is over.

## What counts as a repost

- **Crosspost**: a crosspost of a post from this subreddit, or a plain link to one.
- **Same link**: the same address, ignoring `http`/`https`, `www.`, tracking parameters and trailing slashes. YouTube, X/Twitter and Reddit links are matched across their different spellings.
- **Same title**: the same words, ignoring capitals, punctuation, emoji and spacing.
- **Same text**: a text post whose body has the same words as an earlier one, compared the same way, even under a different title.

A removed post gets a stickied comment that links to the original, and a mod note saying which post it repeated.

The app does not remove a post when:

- the original has itself been removed or deleted,
- the author is a moderator (can be switched off), AutoModerator, or the app,
- the title is very short, such as "Help" or "Question" (the length is a setting),
- the text is very short (the length is a setting),
- it cannot confirm that the original is still up.

It does not compare images, so the same picture uploaded again under a new title is not caught.

## Settings

Moderators can change these from the app's settings page in the subreddit:

| Setting | Default |
| --- | --- |
| Cooldown (days) | 30 |
| Remove crossposts of posts from this subreddit | on |
| Remove posts that share a link with a recent post | on |
| Remove posts that share a title with a recent post | on |
| Shortest title to compare (letters and digits) | 12 |
| Remove text posts that repeat the text of a recent post | on |
| Shortest text to compare (letters and digits) | 40 |
| Never remove posts made by moderators | on |
| Leave a stickied comment explaining the removal | on |
| Removal comment | editable text |

A longer cooldown applies to posts made after the change; a shorter one applies at once.

When the app is installed it reads the subreddit's recent posts (Reddit lists up to 1000), so reposts of posts made before the install are caught too. Moderators can repeat this from the subreddit menu: **Repost Cooldown: rescan recent posts**.

## Development

Requires Node.js 22 or newer. On Windows, keep the project in a folder with a short path.

```bash
npm install
npm test
npm run type-check
npx devvit login
npx devvit playtest <your-test-subreddit>
npx devvit upload
```

`devvit playtest` and `devvit upload` build the server bundle themselves (`npm run build`).

The app name in `devvit.json` must be unique on Reddit. If `repost-cooldown` is taken, change `name` there.

- `src/core/normalize.ts`: turns links and titles into comparable forms.
- `src/core/cooldown.ts`: the rules. No Devvit imports, so it is tested directly in `test/`.
- `src/server/index.ts`: the endpoints Reddit calls, declared in `devvit.json`.
