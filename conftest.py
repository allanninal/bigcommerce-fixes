# Dummy environment so the scripts import cleanly during tests.
# The tests only exercise pure functions, so no real credentials are ever used.
import os

os.environ.setdefault("BIGCOMMERCE_STORE_HASH", "example_hash")
os.environ.setdefault("BIGCOMMERCE_ACCESS_TOKEN", "bc_dummy")
