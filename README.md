# Repost Cooldown

Repost Cooldown keeps your sub from filling up with the same posts.

When someone crossposts a post from your own subreddit, the app checks how old the original is. If it was posted less than 30 days ago, the crosspost is removed.

The app also catches regular reposts: if a new post shares the same link, title or text as a post made in your sub within the last 30 days, it's removed.

A post only counts as an original while it is up. Once it is deleted or removed, the app forgets it, and it can be posted again.

Older posts are fine to share again once the cooldown is over.

## Try it first

You can test how the app behaves in its test subreddit, r/repost_cooldown_dev. Post the same thing there twice, and the second post is removed with a comment that says why.

## What counts as a repost

- **Crosspost**: a crosspost of a post from this subreddit, or a plain link to one.
- **Same link**: the same address, ignoring `http`/`https`, `www.`, tracking parameters, the place on the page (`#section`) and trailing slashes. YouTube, X/Twitter and Reddit links are matched across their different spellings. Links written inside a post's text count too, unless the post has more than five of them or they point at Reddit, including pictures and videos that Reddit hosts. A site's front page, such as `youtube.com`, is never compared.
- **Same title**: the same words, ignoring capitals, punctuation, emoji and spacing. This applies to posts without text, such as images, videos and links. Two posts with text that share a title are only a repost when their text matches too.
- **Same text**: a text post whose body has the same words as an earlier one, compared the same way, even under a different title.

A post that the app removes gets a stickied comment that links to the original, and a mod note saying which post it repeated.

## Deleted and removed posts

Reddit's rules for apps say that an app must forget a post once it is deleted or removed. Repost Cooldown does, whoever took the post down:

| What happened to the original | Posting it again within the cooldown |
| --- | --- |
| Its author deleted it | Allowed |
| A moderator, AutoModerator, Reddit or another app removed it | Allowed |
| It was removed, and a moderator then approved it | Removed, because the original is up again |

So the app cannot stop someone from posting again what a moderator removed. It only compares a new post with posts that are up.

When a moderator approves a post that the app removed, the post stays up and the app deletes its own comment from it.

## Edited posts

When a post is edited, the app reads it again. A link or text that was edited out is forgotten and free for someone else to post, and an edit never gets a post removed.

## What the app keeps

To recognise a repost, the app keeps a fingerprint of each recent post's title, text and links, with the post's ID and the time it was made. A fingerprint is a one-way code: it cannot be turned back into the words or the link. The app keeps no usernames and no copies of posts.

A post's fingerprints are erased when the post is deleted or removed, replaced when it is edited, and otherwise expire when its cooldown ends.

Reddit tells the app about deletions and removals as they happen, but not about every one of them. So once a day the app also reads Reddit's list of the subreddit's newest posts and erases whatever it has recorded that is no longer up there. And nothing is kept for more than 30 days unless the app has read the post again and found it still up, which is the limit Reddit recommends.

## What is left alone

The app does not remove a post when:

- the author is a moderator (can be switched off), AutoModerator, or the app,
- it cannot confirm what happened to the original, or cannot check who the author is.

Very short titles, such as "Help" or "Question", and very short text are not compared; both lengths are settings. A post like that can still be removed for its link.

It does not compare images, so the same picture uploaded again under a new title is not caught.

## Settings

Moderators can change these from the app's settings page in the subreddit:

| Setting | Default |
| --- | --- |
| Cooldown (days) | 30 |
| Remove crossposts of posts from this subreddit | on |
| Remove posts that share a link with a recent post | on |
| Compare links inside a post's text when it has at most this many | 5 |
| Remove posts that share a title with a recent post | on |
| Shortest title to compare (letters and digits) | 12 |
| Remove text posts that repeat the text of a recent post | on |
| Shortest text to compare (letters and digits) | 40 |
| Never remove posts made by moderators | on |
| Leave a stickied comment explaining the removal | on |
| Removal comment | editable text |

A shorter cooldown applies at once. A longer one is only certain to cover posts made after the change; older posts may be forgotten at the old limit.

A cooldown of more than 30 days is fully applied only if the subreddit gets fewer than 1000 posts in that time. Reddit lists a subreddit's newest 1000 posts, and those are the ones the app can re-read each day to keep. In a busier subreddit every post is still covered for at least 30 days.

When the app is installed it reads the subreddit's recent posts (Reddit lists up to 1000), so reposts of posts made before the install are caught too. Moderators can repeat this from the subreddit menu: **Repost Cooldown: rescan recent posts**.
