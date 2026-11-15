# Repost Cooldown

Repost Cooldown keeps your sub from filling up with the same posts.

When someone crossposts a post from your own subreddit, the app checks how old the original is. If it was posted less than 30 days ago, the crosspost is removed.

The app also catches regular reposts: if a new post shares the same link, title or text as a post made in your sub within the last 30 days, it's removed.

If a moderator removed the original, posting it again is removed too. If its author deleted it, it can be posted again.

Older posts are fine to share again once the cooldown is over.

## What counts as a repost

- **Crosspost**: a crosspost of a post from this subreddit, or a plain link to one.
- **Same link**: the same address, ignoring `http`/`https`, `www.`, tracking parameters, the place on the page (`#section`) and trailing slashes. YouTube, X/Twitter and Reddit links are matched across their different spellings. Links written inside a post's text count too, unless the post has more than five of them or they point at Reddit, including pictures and videos that Reddit hosts. A site's front page, such as `youtube.com`, is never compared.
- **Same title**: the same words, ignoring capitals, punctuation, emoji and spacing. This applies to posts without text, such as images, videos and links. Two posts with text that share a title are only a repost when their text matches too.
- **Same text**: a text post whose body has the same words as an earlier one, compared the same way, even under a different title.

A removed post gets a stickied comment that links to the original, and a mod note saying which post it repeated.

## When the original was removed or deleted

| What happened to the original | Posting it again within the cooldown |
| --- | --- |
| A moderator removed it | Removed |
| A moderator removed it, and its author then deleted or edited it | Removed |
| A moderator removed it and later approved it | Removed, because the original is up again |
| Its author deleted it | Allowed |
| AutoModerator, Reddit's filters or another app removed it | Allowed |

A moderator removes a post for a reason, so the app keeps counting that post as the original until its cooldown is over. The repost gets its own comment, which says that the moderators removed the earlier post.

Only a removal made by a person counts. AutoModerator, Reddit's filters and other apps often remove a post because of who posted it or how often, so the same post from someone else is left alone. A removal that a moderator makes through another app counts as that app's.

If you remove a post for something its author can fix, such as a missing flair, and they post it again, the app removes the new post. Approve it to let it through.

This covers removals made while the app is installed. It can be switched off in the settings, and then a removed post no longer blocks anything.

## Edited posts

When a post is edited, the app reads it again. A link or text that was edited out is free for someone else to post, and an edit never gets a post removed.

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
| Remove reposts of posts that a moderator removed | on |
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
| Removal comment when the original was removed by a moderator | editable text |

A shorter cooldown applies at once. A longer one is only certain to cover posts made after the change; older posts may be forgotten at the old limit.

When the app is installed it reads the subreddit's recent posts (Reddit lists up to 1000), so reposts of posts made before the install are caught too. Moderators can repeat this from the subreddit menu: **Repost Cooldown: rescan recent posts**.
