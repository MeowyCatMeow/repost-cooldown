# Repost Cooldown

Repost Cooldown keeps your sub from filling up with the same posts.

If a new post repeats a post made in your sub within the last 30 days, the app removes it. It leaves a stickied comment that links to the original, and a mod note. Once the cooldown is over, the same thing can be posted again.

You can try it in the test subreddit, r/repost_cooldown_dev: post the same thing twice, and the second post is removed.

## What counts as a repost

- **Crosspost**: a crosspost of a post from your subreddit, or a link to one.
- **Same link**: the same address, however it is written. Links inside a post's text count too.
- **Same title**: the same words, ignoring capitals, punctuation and emoji. For a post with text, the text has to match as well.
- **Same text**: the same body text, even under a different title.

## What is left alone

- Posts by moderators, AutoModerator and the app itself.
- Reposts of a post that was deleted, or removed by AutoModerator, Reddit or another app.
- Very short titles such as "Help", and very short text.
- Pictures: the same image under a new title is not caught.
- Edits: an edit never gets a post removed.

If you approve a post the app removed, it stays up and the app deletes its comment.

## Option: posts that a moderator removed

Tick **Also remove reposts of posts that a moderator removed** in the settings, and a post that a moderator removes by hand keeps counting as the original, so posting it again is removed too. It is off unless you tick it.

It lasts until the post's cooldown ends, 30 days at most, or until a moderator approves the post. Deleting the removed post does not get around it: Reddit does not tell the app about that deletion, so the post keeps counting until its time is up.

## Settings

| Setting | Default |
| --- | --- |
| Cooldown (days) | 30 |
| Also remove reposts of posts that a moderator removed | off |
| Moderator accounts whose removals are not counted | none |
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

A cooldown longer than 30 days is fully applied only if the subreddit gets fewer than 1000 posts in that time.

## Menu items

In the subreddit's three-dot menu on Reddit, for moderators:

- **Repost Cooldown: rescan recent posts** re-reads the subreddit's recent posts. The app also does this when it is installed, and once a day.
- **Repost Cooldown: erase stored data** erases everything the app has stored for the subreddit. It warns you and asks first, and cannot be undone. The app stays switched on afterwards.

## What the app keeps

The app keeps no usernames and no copies of posts. For each recent post it keeps a fingerprint of the title, text and links: a one-way code that cannot be turned back into the words.

A post's fingerprints are erased when the post is deleted or removed, and when its cooldown ends. Nothing is kept for more than 30 days unless the app has read the post again and found it still up. The one exception is the option above, which keeps a moderator-removed post for 30 days at most.

Reddit does not tell an app when it is uninstalled. To be certain nothing is left, erase the stored data first, then uninstall.
