# New storefront channel starts with an incomplete category tree

In BigCommerce's Multi-Storefront architecture, a category tree (a `/v3/catalog/trees` object) is a standalone resource assigned to at most one channel at a time. Creating a new storefront channel does not clone the primary storefront's tree, so the new channel starts unassigned or pointed at a fresh, empty tree. Because category-to-tree membership is explicit (categories belong to a specific tree_id, not automatically to all channels), any node created after the second channel was provisioned, or never manually copied, produces a permanent structural gap between the two storefronts' navigation. This job resolves the primary and secondary channel's tree_id, pulls the full category node set for both trees, diffs them by a stable name-and-parent-path key, and backfills only the missing nodes into the secondary tree, parent-first, so every parent_id reference resolves.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/new-channel-incomplete-category-tree/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export PRIMARY_CHANNEL_ID="1"
export SECONDARY_CHANNEL_ID="2"
export DRY_RUN="true"

python new-channel-incomplete-category-tree/python/backfill_category_tree.py
node   new-channel-incomplete-category-tree/node/backfill-category-tree.js
```

`diff_category_trees` (`diffCategoryTrees` in Node) is a pure function that takes only the two trees' plain node arrays (`id`, `parent_id`, `name`) and returns `{missing: [...]}`, so it is fully testable without a network call. It builds a path for every node from its `parent_id` chain, compares by path rather than by id (ids are never shared between two different trees), and sorts the missing nodes by depth so parents are always backfilled before their children. Start with `DRY_RUN=true` to review the full backfill plan, including the resolved parent_id mapping, before writing anything. Never call PUT to change an existing tree's `channels` field, since that field is unsupported on tree updates.

## Test

```bash
pytest new-channel-incomplete-category-tree/python
node --test new-channel-incomplete-category-tree/node
```
