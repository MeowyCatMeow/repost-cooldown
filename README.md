# Repost Cooldown

Repost Cooldown keeps your sub from filling up with the same posts.

A post that repeats another post from your sub is removed, with a stickied comment that links to the original and a mod note. After the cooldown, the same thing can be posted again. The cooldown is 30 days unless you change it.

If you approve a post the app removed, it stays up and the app deletes its comment.

Try it in r/repost_cooldown_dev: post the same thing twice, and the second post is removed.

## What counts as a repost

A post that matches an earlier post in one of these ways:

- **Crosspost**: it crossposts a post from your subreddit, or it is a link post whose link is that post. A text post that only mentions the link does not count.
- **Same link**: it links to the same page, such as the same video or article, however the address is written. A site's front page, such as `youtube.com`, does not count. Links in a post's text count too, unless there are more than five or they point to Reddit.
- **Same title**: the same words, ignoring capitals, punctuation and emoji. For a post with text, the text must match too. Titles under 12 letters are skipped.
- **Same text**: the same words in the body, even under another title. Text under 40 letters is skipped.

An edit is checked too: if it adds text or a link that another post already has, the edited post is removed.

Pictures and uploaded videos are not compared.

## If the earlier post was deleted or removed

| The earlier post was | A repost of it is | With the option on |
| --- | --- | --- |
| Deleted by its author | Allowed | Allowed |
| Removed by AutoModerator, Reddit or another app | Allowed | Allowed |
| Removed by a moderator | Allowed | Removed |
| Removed by a moderator, then approved | Removed | Removed |
| Removed by a moderator, then deleted by its author | Allowed | Removed |

The option is the setting **Also remove reposts of posts that a moderator removed**, which is off unless you tick it. With it on, a post that a moderator removed counts until its cooldown ends, for 30 days after the removal at most.

## Settings

- **Cooldown**: 30 days. One longer than 30 days is fully applied only if the subreddit gets fewer than 1000 posts in that time.
- **The four checks**: each can be switched off, and the numbers in them can be changed.
- **Posts by moderators**: never removed, unless you untick that. Posts by AutoModerator and the app itself are never removed.
- **Posts that a moderator removed**: the option above, and a list of accounts whose removals do not count, for bots that run under an ordinary account.
- **The comment**: on or off, and its wording.

## Menu items

In the subreddit's three-dot menu, for moderators:

- **Repost Cooldown: rescan recent posts** re-reads the subreddit's recent posts. The app also does this when it is installed, and once a day.
- **Repost Cooldown: erase stored data** erases everything the app has stored for the subreddit. It warns you first and cannot be undone. The app stays switched on.

## What the app keeps

No usernames and no copies of posts. For each recent post the app keeps a fingerprint of its title, text and links: a one-way code that cannot be turned back into the words.

A post's fingerprints are erased when it is deleted or removed, and when its cooldown ends. Nothing is kept for more than 30 days unless the app has read the post again and found it still up.

The option above is the one exception. A post that a moderator removed is kept until its time is up, even if its author deletes it, because Reddit does not tell the app about that deletion.

Reddit does not tell an app when it is uninstalled either. To be certain nothing is left, erase the stored data first, then uninstall.
