# Repost Cooldown

Repost Cooldown keeps your sub from filling up with the same posts.

A new post that repeats a post made in your sub in the last 30 days is removed, with a stickied comment that links to the original and a mod note. After the cooldown, the same thing can be posted again.

Try it in r/repost_cooldown_dev: post the same thing twice, and the second post is removed.

## What counts as a repost

**The new post matches an earlier one in one of these ways:**

- **Crosspost**: it crossposts a post from your subreddit, or it is a link post whose link is that post. A text post that only mentions the link does not count.
- **Same link**: it links to the same page, such as the same video or article, however the address is written. A site's front page, such as `youtube.com`, does not count. Links in a post's text count too, unless there are more than five or they point to Reddit.
- **Same title**: the same words, ignoring capitals, punctuation and emoji. For a post with text, the text must match too. Titles under 12 letters are skipped.
- **Same text**: the same words in the body, even under another title. Text under 40 letters is skipped.

**Edits count too.** If an edit adds text or a link that another post already has, the edited post is removed, like a new repost. Only what the edit adds is checked, so a post is not removed for what it already said.

**And the earlier post is one of these:**

| The earlier post | A repost of it is |
| --- | --- |
| Still up | Removed |
| Deleted by its author | Allowed |
| Removed by AutoModerator, Reddit or another app | Allowed |
| Removed by a moderator | Allowed, or removed with the option below |
| Removed by a moderator, then approved | Removed |
| Removed by a moderator, then deleted by its author | Allowed, or removed with the option below |

## Option: posts that a moderator removed

Tick **Also remove reposts of posts that a moderator removed** in the settings. It is off unless you tick it.

- A post that a moderator removes by hand keeps counting as the original until its cooldown ends, 30 days after the removal at most.
- Deleting the removed post does not get around it. Reddit does not tell the app about that deletion, so the post keeps counting until its time is up.
- Approving the post makes it an ordinary post again.
- Only a person's removal counts. A bot that runs under an ordinary account can be named in the settings to leave its removals out.

## What is left alone

- Posts by moderators, AutoModerator and the app itself.
- Pictures and uploaded videos. The app does not look at them: it compares titles, text and links only.
- A post you approve after the app removed it. It stays up, and the app deletes its comment.

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
