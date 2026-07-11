# Product invisible on a channel despite correct category and visibility flags

Category membership and the product's `is_visible` flag only control whether a product can appear within a category tree or search index. They say nothing about which sales channel exposes the product at all. A product is only reachable on a given channel if it has an explicit row in the products-channel-assignments table, created with a PUT to `/v3/catalog/products/channel-assignments`. New storefronts and channels do not automatically inherit assignments from the default channel, and bulk imports, CSV product uploads, and the default Channel Manager flow can silently skip a newly created channel. This job lists every channel, every visible catalog product, and every channel's assigned product ids, then reports every (product_id, channel_id) gap. It is not safe to auto-fix blindly, a missing assignment can be intentional for a channel-specific catalog, so by default this only reports.

**Full guide with diagrams:** https://www.allanninal.dev/bigcommerce/product-invisible-missing-channel-assignment/

## Run it

```bash
export BIGCOMMERCE_STORE_HASH="your_store_hash"
export BIGCOMMERCE_ACCESS_TOKEN="your_access_token"
export DRY_RUN="true"
export REPORT_PATH="channel_assignment_gaps.csv"

python product-invisible-missing-channel-assignment/python/find_missing_channel_assignments.py
node   product-invisible-missing-channel-assignment/node/find-missing-channel-assignments.js
```

Both scripts write a CSV report of every `(product_id, channel_id)` gap by default and take no other action.

To also write assignments for one specific channel once you have reviewed the report, add `--repair-channel=<channel_id>`:

```bash
python product-invisible-missing-channel-assignment/python/find_missing_channel_assignments.py --repair-channel=123456
node   product-invisible-missing-channel-assignment/node/find-missing-channel-assignments.js --repair-channel=123456
```

Keep `DRY_RUN=true` while reviewing the planned writes; only set `DRY_RUN=false` once you are ready to actually call `PUT /v3/catalog/products/channel-assignments`.

`find_missing_channel_assignments` (`findMissingChannelAssignments` in Node) is a pure function that takes the full set of catalog product ids, a mapping of channel_id to the set of product ids assigned to that channel, and the set of visible product ids, so it is fully testable without a network call. It returns a sorted list of `(product_id, channel_id)` pairs for every visible product missing from a channel's assignment set.

## Test

```bash
pytest product-invisible-missing-channel-assignment/python
node --test product-invisible-missing-channel-assignment/node
```
