---
title: "I failed an interview question about cursor pagination, so I measured it"
summary: "The question was how cursor based pagination works in Shopify, and whether it needs an index or a UUID primary key. I did not know. So I went home and ran EXPLAIN ANALYZE until I did."
date: 2026-09-14
tags: [postgres, sql, pagination]
status: published
---

I had an interview recently, and I did not do well. The question was about
cursor based pagination in Shopify. This is what I found out.

I did not know the answer in the interview. So I went home, I loaded the dataset
from the task, and I measured it. It has 50 000 rows on Postgres 18. The page
size is 25. The sort is `follower_count DESC, id ASC`.

## The two queries

Offset pagination gets all the rows it needs. It skips all the rows before the
offset. Then it gives us our 25 rows.

```sql
SELECT * FROM creators
ORDER BY follower_count DESC, id ASC
LIMIT 25 OFFSET 24975;
```

Cursor pagination just asks: after the last row that we sent, give me the next
25 rows.

```sql
SELECT * FROM creators
WHERE (follower_count, id) < (22954, 47160)
ORDER BY follower_count DESC, id DESC
LIMIT 25;
```

So it is a filter on the sort key, and not a position. The sort key here is
`(follower_count, id)`, and not the primary key. If you send only the `id`, you
get the wrong rows.

## Speed

| Page | Offset | Cursor |
|---|---|---|
| 1 | 0.098 ms | 0.142 ms |
| 1000 | 7.93 ms | 0.104 ms |
| 2000 | **19.42 ms** | **0.073 ms** |

The offset cost increases with the page number. The cursor cost is flat. The
query plan shows the cause:

```
 Limit (rows=25.00)
   ->  Incremental Sort (rows=50000.00)      <-- read 50 000 rows to return 25
```

`OFFSET` is not a seek. It is a count. The index is correct, and the index does
not help, because the work is in the skip step. The offset page also needs a
second query for the total, and `SELECT count(*)` costs 5.2 ms on every page.

![Drake rejects reading 50000 rows to return 25](/images/posts/i-failed-an-interview-question-about-cursor-pagination-so-i-measured-it/offset-vs-cursor.webp)

## We do not lose rows

This is the more important benefit. In a hot table we do not lose rows when the
order shifts.

We read page 2, 25 rows on each page. Then somebody deletes the 20th row.
Everything moves up one position. The old 26th row is now the 25th row, and the
25th row is on page 1. We read page 1 before the change. So `OFFSET 25` starts
at the old 27th row, and we never see the old 26th row.

I reproduced this. The row `creator_4436` is simply not in the offset result:

```
next unseen rows are:   4436, 13257, 42253

OFFSET page 2 returns:  13257, 42253, 7356        <-- 4436 is not here
CURSOR page 2 returns:  4436, 13257, 42253
```

The database shows no error. In a user interface this is a bug. In a background
job that finds new matches, a skipped row is a missed match.

## What it needs

The interviewer also asked if it needs an index, or a UUID primary key.

It needs a unique tiebreak at the end of the sort. Two creators can have the
same follower count, so "after 41 200" is not a position without the `id`.

It needs an index that matches the `ORDER BY`, with the same columns in the same
sequence. Without it, the database sorts the full result and you get no benefit.

A UUID primary key is not a condition. A `bigint` is sufficient. A random
UUIDv4 is worse, because it has no useful order and it writes to all parts of
the btree. UUIDv7 and ULID are acceptable, because they sort by time.

## Drawbacks

It only works for infinite scroll type of pagination. We need the previous
page's sort key to pass to our cursor. There is no jump to page N, and no total
count.

Shopify accepts these limits. You send `after: endCursor`, you get
`pageInfo.hasNextPage`, and most connections give you no total. To find
`hasNextPage`, request one more row than the page size. If the extra row exists,
then there is a next page.

One more rule: a cursor is correct only for the query that made it. If you
change the sort or the filters, you must start again.

---

I hope that this helps someone. It is useful to know that this technique exists.
