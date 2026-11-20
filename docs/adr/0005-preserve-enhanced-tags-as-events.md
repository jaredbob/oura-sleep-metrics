# Preserve Enhanced Tags as events

Keep one owner-only record per Oura Enhanced Tag document, preserving Oura’s start and optional end dates and times so overlapping tags and multiple tags on the same day can be queried alongside nightly readings without duplicating those readings. Date-range repair uses the Oura-reported start day as its boundary and checks missing records by document ID, so a tag moved to another date can be reconciled. Store built-in tag codes and custom names for analysis and discard optional comments to avoid retaining personal notes.
