# Repost Cooldown

Repost Cooldown keeps your sub from filling up with the same posts.

When someone crossposts a post from your own subreddit, the app checks how old the original is. If it was posted less than 30 days ago, the crosspost is removed.

The app also catches regular reposts: if a new post shares the same link, title or text as a post made in your sub within the last 30 days, it's removed.

If the original's author deleted it, the app forgets it and it can be posted again. If a moderator removed it, the same goes, unless you switch on the option that keeps such a post counting as the original.

Older posts are fine to share again once the cooldown is over.

## Try it first

You can test how the app behaves in its test subreddit, r/repost_cooldown_dev. Post the same thing there twice, and the second post is removed with a comment that says why.

## What counts as a repost

- **Crosspost**: a crosspost of a post from this subreddit, or a plain link to one.
- **Same link**: the same address, ignoring `http`/`https`, `www.`, tracking parameters, the place on the page (`#section`) and trailing slashes. YouTube, X/Twitter and Reddit links are matched across their different spellings. Links written inside a post's text count too, unless the post has more than five of them or they point at Reddit, including pictures and videos that Reddit hosts. A site's front page, such as `youtube.com`, is never compared.
- **Same title**: the same words, ignoring capitals, punctuation, emoji and spacing. This applies to posts without text, such as images, videos and links. Two posts with text that share a title are only a repost when their text matches too.
- **Same text**: a text post whose body has the same words as an earlier one, compared the same way, even under a different title.

A post that the app removes gets a stickied comment that links to the original, and a mod note saying which post it repeated.

## When the original was removed or deleted

| What happened to the original | Posting it again within the cooldown |
| --- | --- |
| Its author deleted it | Allowed |
| Reddit took it down | Allowed |
| AutoModerator, Reddit's filters or another app removed it | Allowed |
| A moderator removed it | Allowed, or removed if the option below is on |
| A moderator removed it and later approved it | Removed, because the original is up again |
| A moderator removed it, and its author then deleted it | Allowed, or with the option on, removed until the original's time is up |

### The option for posts that a moderator removed

In the app's settings there is a box: **Also remove reposts of posts that a moderator removed**. It is not ticked unless you tick it.

With it ticked, a post that a moderator removes keeps counting as the original until its cooldown ends, for 30 days at most. A moderator removes a post for a reason, so posting it again is removed too. The repost gets its own comment, which says that the moderators removed the earlier post.

Only a removal made by a person counts. AutoModerator, Reddit's filters and other apps often remove a post because of who posted it or how often, so the same post from someone else is left alone. A removal that a moderator makes through another app counts as that app's. A bot that runs under an ordinary account looks like a person, so name such accounts in the settings to leave their removals out.

For a post kept this way, the app goes by what Reddit tells it. Reddit tells the app when a moderator approves the post, and the post is an ordinary one again. Reddit does not tell the app when the author of a removed post deletes it, and the app does not go looking. So that post keeps counting until its time is up: the end of its cooldown, and 30 days after the removal at most. This is what stops someone from deleting a removed post only to post it again. If Reddit does send the app a delete event for the post, the app erases it at once.

If you remove a post for something its author can fix, such as a missing flair, and they post it again, the app removes the new post. Approve it to let it through.

The option covers removals made while it is ticked. Untick it, and the app forgets the removed posts it was remembering: the recent ones at its next daily check, any older one within 30 days.

### Approving a post the app removed

When a moderator approves a post that the app removed, the post stays up and the app deletes its own comment from it. The app remembers which comment that is for 30 days at most.

## Edited posts

When a post is edited, the app reads it again. A link or text that was edited out is forgotten and free for someone else to post, and an edit never gets a post removed.

## What the app keeps

To recognise a repost, the app keeps a fingerprint of each recent post's title, text and links, with the post's ID and the time it was made. A fingerprint is a one-way code: it cannot be turned back into the words or the link. The app keeps no usernames and no copies of posts.

How long it keeps them:

| The post | Its fingerprints |
| --- | --- |
| Is up | Kept until its cooldown ends |
| Was deleted by its author, or taken down by Reddit | Erased |
| Was removed by AutoModerator, a filter or another app | Erased |
| Was removed by a moderator | Erased. With the option ticked: kept until its cooldown ends or a moderator approves it, and for 30 days at most after the removal. If its author deletes it in that time, Reddit does not tell the app, and the fingerprints stay until that time is up |
| Was edited | What it no longer contains is erased |

Reddit tells the app about most of these as they happen, and the app erases at once. It does not tell the app about all of them. So once a day the app also reads Reddit's list of the subreddit's newest posts and erases whatever it has recorded that should no longer be there. The daily check leaves one kind of post alone: a post that a moderator removed, where the option is ticked. And nothing is kept for more than 30 days after the app last read the post and found it up, which is the limit Reddit recommends.

### Erasing everything

Moderators can erase everything the app has stored for the subreddit. This is not on the settings page: it is an item in the subreddit's three-dot menu on Reddit, **Repost Cooldown: erase stored data**, next to the rescan item. It shows a warning and asks first, because erasing cannot be undone.

The app stays switched on afterwards. It records new posts as they come in, and reads the existing ones again at its next daily check or when you pick the rescan. Until then, reposts of posts that are up are not caught, and posts that a moderator removed are no longer remembered at all. It no longer knows which removal comments it left before, so approving a post it removed earlier will not delete that comment.

What a version of the app up to 0.0.21 stored, and the app can no longer find, is not covered. It expires by itself, at the latest when the cooldown of the post it belongs to ends. The one exception is a marker those versions kept for a post that a moderator removed: it holds nothing but the post's ID, and can last up to a year.

### Uninstalling

Reddit does not tell an app that it is being uninstalled, so the app cannot erase anything at that moment. Reddit's own guidance for moderators says that an uninstalled app's data and settings are lost and cannot be got back by installing it again. To be certain, erase the stored data first and then uninstall.

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
| Also remove reposts of posts that a moderator removed | off |
| Moderator accounts whose removals are not counted (used with the option above) | none |
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

A cooldown of more than 30 days is fully applied only if the subreddit gets fewer than 1000 posts in that time. Reddit lists a subreddit's newest 1000 posts, and those are the ones the app can re-read each day to keep. In a busier subreddit every post is still covered for at least 30 days.

When the app is installed it reads the subreddit's recent posts (Reddit lists up to 1000), so reposts of posts made before the install are caught too. Moderators can repeat this from the subreddit menu: **Repost Cooldown: rescan recent posts**.
